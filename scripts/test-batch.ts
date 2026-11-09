import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runBatch } from "../src/batch.js";
import type { ProgressEvent } from "../src/pipeline.js";
import { acquireLease } from "../src/lock.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tweetmd-batch-"));
try {
  let active = 0, calls = 0, probes = 0;
  let reportPath = "";
  for await (const event of runBatch("https://x.com/a/status/1?s=46 [https://x.com/a/status/1](https://x.com/a/status/1) https://x.com/b/status/2", { outBase: dir, headless: true, enrich: true, resume: true }, {
    provider: async () => { probes++; return { available: false, authenticated: false }; },
    pipeline: async function* (options): AsyncGenerator<ProgressEvent> {
      assert.equal(active++, 0, "Persistent-profile work must stay sequential");
      assert.equal(options.resume, true);
      assert.equal(options.provider?.available, false);
      const checkpoint = (await fs.readdir(path.join(dir, ".batches"))).find((file) => file.endsWith(".json"))!;
      const state = JSON.parse(await fs.readFile(path.join(dir, ".batches", checkpoint), "utf8"));
      assert.equal(state.items[calls].status, "running");
      calls++;
      yield { type: "error", error: "X did not serve the tweet" };
      active--;
    },
  })) if (event.type === "batch") { reportPath = event.path; assert.deepEqual(event.report.items.map((item) => item.status), ["failed", "failed"]); }
  assert.equal(calls, 2);
  assert.equal(probes, 1);
  assert.equal(JSON.parse(await fs.readFile(reportPath, "utf8")).items.length, 2);
  const lease = path.join(dir, "lock");
  const release = await acquireLease(lease);
  await assert.rejects(acquireLease(lease, 1), /Timed out/);
  await release();
  await fs.writeFile(lease, JSON.stringify({ pid: 2147483647, token: "dead" }));
  const recover = await acquireLease(lease, 1000); await recover();
  console.log("Batch deduplication, serialization, shared preflight, checkpoints and leases passed");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
