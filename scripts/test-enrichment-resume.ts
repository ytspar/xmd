/** Run with: npx tsx scripts/test-enrichment-resume.ts */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preflightClaude } from "../src/provider.js";
import { enrichImages, isValidEnrichment } from "../src/enrich.js";
import { downloadAllMedia } from "../src/media.js";
import type { Thread, MediaItem } from "../src/types.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tweetmd-enrichment-"));
const originalFetch = globalThis.fetch;
const media = (url: string): MediaItem => ({ url, type: "photo" });
const thread = (images: MediaItem[]): Thread => ({
  main: { id: "1", author: { name: "Author", handle: "author" }, text: "article", url: "https://x.com/author/status/1",
    createdAtRaw: "", metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0 }, media: images, isMainTweet: true },
  ancestors: [], replies: [], capturedAt: "", sourceUrl: "https://x.com/author/status/1",
});
try {
  const bin = path.join(dir, "claude-mock");
  const log = path.join(dir, "calls");
  const fake = async (status: string, result: string) => {
    await fs.writeFile(log, "");
    await fs.writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$1" = auth ]; then\n  printf '%s' '${status}'\nelse\n  printf '%s' '${result}'\nfi\n`, { mode: 0o700 });
  };
  await fake('{"loggedIn":false,"email":"private@example.com"}', '{"result":"OK"}');
  const denied = await preflightClaude(bin);
  assert.equal(denied.available, false);
  assert.doesNotMatch(JSON.stringify(denied), /private@example/);
  assert.equal((await fs.readFile(log, "utf8")).trim().split("\n").length, 1, "Signed-out status must not launch a request");
  await fake('{"loggedIn":true}', '{"result":"OK"}');
  assert.equal((await preflightClaude(bin)).available, true);
  assert.equal((await fs.readFile(log, "utf8")).trim().split("\n").length, 2);
  await fake('{"loggedIn":true}', '{"is_error":true,"result":"expired session"}');
  assert.equal((await preflightClaude(bin)).available, false, "A stale login status must not pass a failing request probe");

  const images = [media("https://example.com/keep.jpg"), media("https://example.com/retry.jpg"), media("https://example.com/decorative.jpg")];
  images[0].localPath = "media/keep.jpg";
  images[0].enrichment = { kind: "text", description: "Kept analysis", content: "kept" };
  images[0].downloadError = "old error";
  images[1].downloadError = "failed earlier";
  images[2].enrichment = { kind: "decorative", description: "Already removed decorative image" };
  await fs.mkdir(path.join(dir, "media"));
  await fs.writeFile(path.join(dir, "media/keep.jpg"), "unchanged");
  images[1].inline = true;
  images[1].articleIndex = 7;
  const fetched: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetched.push(String(url));
    return new Response("new image", { status: 200 });
  }) as typeof fetch;
  const t = thread(images);
  await downloadAllMedia(t, dir, () => {}, { resume: true });
  assert.deepEqual(fetched, ["https://example.com/retry.jpg"]);
  assert.equal(await fs.readFile(path.join(dir, "media/keep.jpg"), "utf8"), "unchanged");
  assert.equal(images[0].downloadError, undefined);
  assert.equal(images[1].downloadError, undefined);
  assert.equal(images[1].localPath, "media/1-7.jpg", "Inline paths must use source Article media indexes");
  assert.equal(images[2].localPath, undefined);
  const callsBefore = await fs.readFile(log, "utf8");
  const summary = await enrichImages(t, dir, { resume: true, provider: denied, claudeBin: bin, noCache: true });
  assert.equal(summary.failed, 1);
  assert.match(images[1].enrichmentError!, /signed out/);
  assert.equal(images[0].enrichment?.content, "kept");
  assert.equal(await fs.readFile(log, "utf8"), callsBefore, "Unavailable provider must not invoke a CLI per image");

  await fake('{"loggedIn":true}', '{"result":"{}"}');
  const bad = thread([images[1]]);
  const invalid = await enrichImages(bad, dir, { provider: { available: true, authenticated: true }, claudeBin: bin, noCache: true });
  assert.equal(invalid.failed, 1);
  assert.match(images[1].enrichmentError!, /valid kind/);
  assert.equal(isValidEnrichment({}), false);
  assert.equal(isValidEnrichment({ kind: "text", description: "missing content" }), false);
  assert.equal(isValidEnrichment({ kind: "decorative", description: "decoration" }), true);
  globalThis.fetch = (async () => new Response("failure", { status: 503 })) as typeof fetch;
  const failure = thread([media("https://example.com/missing.jpg")]);
  await downloadAllMedia(failure, path.join(dir, "failure"));
  assert.match(failure.main.media[0].downloadError!, /503/);
  assert.equal(failure.main.media[0].localPath, undefined);
  console.log("Provider preflight, partial media and resume checks passed");
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(dir, { recursive: true, force: true });
}
