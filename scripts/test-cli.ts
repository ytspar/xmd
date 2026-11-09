/** End-to-end CLI reporting over a saved fixture, with no provider or browser. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tweetmd-cli-"));
try {
  const bundle = path.join(dir, "author_123"); await fs.mkdir(bundle);
  await fs.writeFile(path.join(bundle, "thread.json"), JSON.stringify({
    main: { id: "123", url: "https://x.com/author/status/123", author: { name: "Author", handle: "author" }, text: "Saved text", createdAtRaw: "", metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0 }, media: [], isMainTweet: true },
    ancestors: [], replies: [], sourceUrl: "https://x.com/author/status/123", capturedAt: "2026-11-04T00:00:00Z",
  }));
  const entry = process.env.TWEETMD_TEST_COMPILED ? ["dist/cli.js"] : ["--import", "tsx", "src/cli.tsx"];
  const result = spawnSync(process.execPath, [...entry, "batch", "https://x.com/author/status/123?s=46 https://x.com/author/status/123", "--resume", "--no-enrich", "--no-links", "--no-categorize", "--out", dir], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /0 complete, 1 partial, 0 failed/);
  assert.equal(JSON.parse(await fs.readFile(path.join(bundle, "capture.json"), "utf8")).status, "partial");
  assert.equal(JSON.parse(await fs.readFile(path.join(bundle, "raw-thread.json"), "utf8")).main.text, "Saved text");
  const journals = (await fs.readdir(path.join(dir, ".batches"))).filter((file) => file.endsWith(".json"));
  assert.equal(journals.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, ".batches", journals[0]), "utf8")).items.length, 1);
  console.log(`${process.env.TWEETMD_TEST_COMPILED ? "Compiled" : "Source"} CLI partial exit code, normalization and recovery smoke passed`);
} finally { await fs.rm(dir, { recursive: true, force: true }); }
