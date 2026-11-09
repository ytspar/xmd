/** Run with: npx tsx scripts/test-backfill-coverage.ts */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backfillBundleEnrichment, backfillEnrichmentAll, writeBundle } from "../src/render.js";
import { newCaptureReport } from "../src/capture.js";
import { acquireLease } from "../src/lock.js";
import type { Thread } from "../src/types.js";
const base = await fs.mkdtemp(path.join(os.tmpdir(), "tweetmd-backfill-"));
const manual = { kind: "text" as const, description: "Human-reviewed screenshot", content: "Manual transcript must survive" };
const create = async (id: string) => {
  const thread: Thread = {
    main: { id, url: `https://x.com/author/status/${id}`, author: { name: "Author", handle: "author" }, text: "Body",
      createdAtRaw: "", metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0 }, isMainTweet: true,
      media: [{ url: "https://example.com/manual.jpg", type: "photo", localPath: "media/manual.jpg", enrichment: manual },
        { url: "https://example.com/pending.jpg", type: "photo", localPath: "media/pending.jpg", enrichmentError: "Expired auth" }] },
    ancestors: [], replies: [], sourceUrl: `https://x.com/author/status/${id}`, capturedAt: "",
  };
  thread.capture = newCaptureReport(thread);
  for (const stage of Object.values(thread.capture.stages)) stage.status = "complete";
  thread.capture.stages.ocr = { status: "partial", completed: 1, total: 2, message: "Expired auth" };
  thread.capture.status = "partial";
  const result = await writeBundle(thread, base);
  await fs.mkdir(path.join(result.outDir, "media"));
  await fs.writeFile(path.join(result.outDir, "media/manual.jpg"), "manual bytes");
  await fs.writeFile(path.join(result.outDir, "media/pending.jpg"), "pending bytes");
  return result.outDir;
};
try {
  const bin = path.join(base, "fake-claude");
  const log = path.join(base, "calls");
  await fs.writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$1" = auth ]; then\n printf '%s' '{"loggedIn":true}'\nelse\n input=$(cat)\n if [ "$input" = 'Reply with OK only.' ]; then\n  printf '%s' '{"result":"OK"}'\n else\n  printf '%s' '{"result":"{\\"kind\\":\\"text\\",\\"description\\":\\"Recovered OCR\\",\\"content\\":\\"New transcript\\"}"}'\n fi\nfi\n`, { mode: 0o700 });
  const dirs = [await create("101"), await create("102")];
  const summary = await backfillEnrichmentAll(base, { claudeBin: bin, noCache: true });
  assert.equal(summary.bundlesTouched, 2);
  assert.equal(summary.analyzed, 2);
  assert.equal(summary.failed, 0);
  const calls = (await fs.readFile(log, "utf8")).trim().split("\n");
  assert.equal(calls.filter((call) => call.startsWith("auth ")).length, 1, "One shared auth preflight per library sweep");
  assert.equal(calls.length, 4, "One auth check, one probe, two OCR calls; completed manual OCR is never resent");
  for (const dir of dirs) {
    const thread = JSON.parse(await fs.readFile(path.join(dir, "thread.json"), "utf8"));
    assert.deepEqual(thread.main.media[0].enrichment, manual);
    assert.equal(thread.main.media[1].enrichment.content, "New transcript");
    assert.equal(thread.capture.stages.ocr.status, "complete");
    assert.equal(thread.capture.status, "complete");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "capture.json"), "utf8")), thread.capture);
    assert.match(await fs.readFile(path.join(dir, "tweet.md"), "utf8"), /ocr: complete/);
    assert.equal(await fs.stat(path.join(base, ".locks", `${thread.main.id}.lock`)).then(() => true).catch(() => false), false);
  }
  // Simulate a capture completing the missing OCR while backfill waits for its writer lease.
  const concurrent = await create("103");
  const release = await acquireLease(path.join(base, ".locks", "103.lock"));
  const waiting = backfillBundleEnrichment(concurrent, { claudeBin: bin, noCache: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const latest = JSON.parse(await fs.readFile(path.join(concurrent, "thread.json"), "utf8"));
  latest.main.media[1].enrichment = manual;
  await fs.writeFile(path.join(concurrent, "thread.json"), JSON.stringify(latest));
  await release();
  assert.equal(await waiting, null, "Backfill must re-read after acquiring the lease");
  assert.equal((await fs.readFile(log, "utf8")).trim().split("\n").length, 4);
  console.log("OCR backfill preservation, shared preflight, writer lease and coverage checks passed");
} finally { await fs.rm(base, { recursive: true, force: true }); }
