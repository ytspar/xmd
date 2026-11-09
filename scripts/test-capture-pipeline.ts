/** Failure and recovery tests: npx tsx scripts/test-capture-pipeline.ts */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPipeline, type PipelineServices, type ProgressEvent } from "../src/pipeline.js";
import { parseArticle, normalizeLegacyArticleMarkers } from "../src/article.js";
import { articleIssues, finalizeCapture, newCaptureReport } from "../src/capture.js";
import { renderTweetDoc } from "../src/render.js";
import { tweetUrls } from "../src/input.js";
import { followLinkedTweets, refreshIncompleteArticles } from "../src/linked-tweets.js";
import type { Thread } from "../src/types.js";

async function collect(events: AsyncIterable<ProgressEvent>): Promise<ProgressEvent[]> {
  const results: ProgressEvent[] = [];
  for await (const event of events) results.push(event);
  return results;
}
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tweetmd-pipeline-"));
const makeThread = (id = "123"): Thread => ({
  main: { id, url: `https://x.com/author/status/${id}`, author: { name: "Author", handle: "author" }, text: "Payload", createdAtRaw: "", metrics: { likes: 0, retweets: 0, replies: 99, quotes: 0 }, media: [{ url: "https://cdn.example/image.jpg", type: "photo" }], isMainTweet: true },
  ancestors: [], replies: [], sourceUrl: `https://x.com/author/status/${id}`, capturedAt: "2026-11-04T00:00:00Z",
});
try {
  assert.deepEqual(tweetUrls("[https\\://x.com/a\\_b/status/123?s=46](https://x.com/a_b/status/123) https://twitter.com/c/status/456?x=1"), ["https://x.com/a_b/status/123", "https://x.com/c/status/456"]);
  let scrapes = 0, probes = 0, enrichCalls = 0, sourceCalls = 0;
  const services: Partial<PipelineServices> = {
    scrape: async () => { scrapes++; return makeThread(); },
    provider: async () => { probes++; return { available: false, authenticated: false, error: "Expired authentication" }; },
    media: async (thread, outDir) => {
      thread.main.media[0].localPath = "media/image.jpg";
      await fs.mkdir(path.join(outDir, "media"), { recursive: true });
      await fs.writeFile(path.join(outDir, "media/image.jpg"), "image");
    },
    enrich: async (thread, outDir, options) => {
      enrichCalls++;
      assert.equal(JSON.parse(await fs.readFile(path.join(outDir, "raw-thread.json"), "utf8")).main.text, "Payload");
      assert.equal(options?.provider?.available, false);
      thread.main.media[0].enrichmentError = "Expired authentication";
      return { analyzed: 0, failed: 1, providerError: "Expired authentication" };
    },
    references: async (thread) => { sourceCalls++; thread.references = [{ url: "https://example.com/article", title: "Article", kind: "web", sourceTweetId: "123", files: [], error: "blocked", status: "failed" }]; },
    categorize: async () => { throw new Error("Must not classify with expired auth"); },
  };
  const options = { url: "https://x.com/author/status/123", outBase: dir, headless: true, enrich: true };
  const first = await collect(runPipeline(options, services));
  const done = first.find((event) => event.type === "done");
  assert.ok(done?.type === "done");
  assert.equal(done.thread.capture?.status, "partial");
  assert.equal(done.thread.capture?.stages.ocr.status, "partial");
  assert.equal(done.thread.capture?.stages.category.status, "failed");
  assert.equal(done.thread.capture?.stages.references.status, "partial");
  assert.equal(probes, 1);
  assert.match(await fs.readFile(done.result.markdownPath, "utf8"), /Capture coverage/);
  assert.equal(JSON.parse(await fs.readFile(path.join(done.result.outDir, "capture.json"), "utf8")).conversation.completeness, "unknown");
  // Resume from the saved text. A subsequent optional-stage crash still keeps raw text.
  const second = await collect(runPipeline({ ...options, resume: true }, { ...services, enrich: async () => { throw new Error("Vision crashed"); } }));
  const resumed = second.find((event) => event.type === "done");
  assert.ok(resumed?.type === "done");
  assert.equal(resumed.thread.capture?.stages.ocr.status, "failed");
  assert.equal(scrapes, 1);
  assert.equal(sourceCalls, 2);
  assert.equal(enrichCalls, 1);
  const failedReferences = await collect(runPipeline({ ...options, resume: true }, { ...services, references: async () => { throw new Error("Reference stage crashed"); } }));
  const failedSource = failedReferences.find((event) => event.type === "done");
  assert.ok(failedSource?.type === "done");
  assert.equal(failedSource.thread.capture?.stages.references.status, "failed");
  assert.equal(failedSource.thread.capture?.stages.references.message, "Reference stage crashed");
  // Missing native Article bodies are the one case where resume refreshes saved text.
  const saved = JSON.parse(await fs.readFile(done.result.jsonPath, "utf8")) as Thread;
  saved.main.isArticle = true; saved.main.articleIssues = ["Article body was not served by X."];
  await fs.writeFile(done.result.jsonPath, JSON.stringify(saved));
  const recovered = await collect(runPipeline({ ...options, resume: true }, { ...services, scrape: async () => { const full = makeThread(); full.main.isArticle = true; full.main.text = "# Full recovered article"; return full; } }));
  const recoveredDone = recovered.find((event) => event.type === "done");
  assert.ok(recoveredDone?.type === "done");
  assert.equal(recoveredDone.thread.main.text, "# Full recovered article");
  assert.equal(recoveredDone.thread.capture?.stages.articles.status, "complete");
  // Reuse successful model classification only while its inputs remain unchanged.
  let classifications = 0;
  const classifyServices: Partial<PipelineServices> = {
    scrape: async () => { const fresh = makeThread("456"); fresh.main.media = []; return fresh; },
    media: async () => {}, references: async () => {},
    provider: async () => ({ available: true, authenticated: true }),
    categorize: async () => { classifications++; return { category: "test-topic" }; },
  };
  const classifiedOptions = { ...options, url: "https://x.com/author/status/456", enrich: false };
  const classified = await collect(runPipeline(classifiedOptions, classifyServices));
  await collect(runPipeline({ ...classifiedOptions, resume: true }, classifyServices));
  assert.equal(classifications, 1);
  const classifiedDone = classified.find((event) => event.type === "done");
  assert.ok(classifiedDone?.type === "done");
  const changed = JSON.parse(await fs.readFile(classifiedDone.result.jsonPath, "utf8"));
  changed.main.text += " Newly recovered source detail";
  await fs.writeFile(classifiedDone.result.jsonPath, JSON.stringify(changed));
  await collect(runPipeline({ ...classifiedOptions, resume: true }, classifyServices));
  assert.equal(classifications, 2);
  // An Article refresh must never replace a full saved body with a teaser.
  const rich = makeThread("888"); rich.main.isArticle = true; rich.main.text = "Full article paragraph. ".repeat(100) + "[Original image: missing]";
  const original = rich.main.text;
  await refreshIncompleteArticles(rich, async () => makeThread("888"));
  assert.equal(rich.main.text, original);
  assert.match(rich.main.articleIssues!.join(" "), /retained saved article/);
  // Legacy assignments are retained and clearly named even when reclassification is blocked.
  const legacy = { categories: [] as { id: string; label: string }[], items: [] as { slug: string; category: string }[] };
  legacy.categories.push({ id: "known-topic", label: "Known topic" });
  legacy.items.push({ slug: "author_777", category: "known-topic" });
  await fs.writeFile(path.join(dir, "categories.json"), JSON.stringify(legacy));
  const legacyEvents = await collect(runPipeline({ ...options, url: "https://x.com/author/status/777" }, { ...services, scrape: async () => makeThread("777") }));
  const legacyDone = legacyEvents.find((event) => event.type === "done");
  assert.ok(legacyDone?.type === "done");
  assert.equal(legacyDone.thread.capture?.stages.category.status, "partial");
  assert.match(legacyDone.thread.capture!.stages.category.message!, /Retained known-topic/);
  assert.match(renderTweetDoc(legacyDone.thread), /Image analysis unavailable/);
  // A random reply's unresolved Article embed must not mark the author's Article incomplete.
  const discussion = makeThread("999"); discussion.main.media = [];
  discussion.replies.push({ ...makeThread("1000").main, author: { handle: "other", name: "Other" }, text: "[[embedded-tweet:1001]]", isArticle: true });
  discussion.capture = newCaptureReport(discussion);
  finalizeCapture(discussion);
  assert.equal(discussion.capture.stages.articles.status, "complete");
  assert.match(discussion.capture.warnings.join(" "), /Supplemental reply content/);
  const divider = parseArticle({ content_state: { blocks: [{ type: "atomic", entityRanges: [{ key: 0 }] }], entityMap: [{ key: "0", value: { type: "DIVIDER", data: {} } }] } }, "123");
  assert.equal(divider.markdown, "---");
  assert.equal(normalizeLegacyArticleMarkers("Before\n\n[Unsupported article entity: DIVIDER]\n\nAfter"), "Before\n\n---\n\nAfter");
  const article = parseArticle({ content_state: { blocks: [{ type: "atomic", entityRanges: [{ key: 0 }] }], entityMap: [{ key: "0", value: { type: "MEDIA", data: { mediaItems: [{ mediaId: "missing" }, { mediaId: "second" }] } } }] } }, "123");
  assert.match(article.markdown, /Original image: missing/);
  assert.match(article.markdown, /Original image: second/);
  const issueThread = makeThread(); issueThread.main.text = article.markdown;
  assert.equal(articleIssues(issueThread).length, 2);
  issueThread.capture = newCaptureReport(issueThread);
  finalizeCapture(issueThread);
  assert.match(renderTweetDoc(issueThread), /unresolved article image/);
  const linked = makeThread(); linked.main.text = "Read https://x.com/source/status/456 and https://x.com/source/status/789 and https://x.com/source/status/999";
  let linkedCalls = 0;
  await followLinkedTweets(linked, async (url) => { linkedCalls++; if (url.endsWith("789")) throw new Error("Deleted"); return makeThread(url.match(/\d+$/)![0]); }, { limit: 2 });
  assert.equal(linkedCalls, 2);
  assert.deepEqual(linked.linkedTweets?.map((link) => link.status), ["complete", "failed", "skipped"]);
  await followLinkedTweets(linked, async () => { linkedCalls++; return makeThread("789"); }, { resume: true, limit: 1 });
  assert.equal(linkedCalls, 3, "Resume must not refetch successful linked tweets");
  console.log("Capture checkpoint, partial reporting, article-gap and bounded-link tests passed");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
