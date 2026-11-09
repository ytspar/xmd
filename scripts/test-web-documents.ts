import "./fixtures/public-dns.js";
/** Run with: pnpm exec tsx scripts/test-web-documents.ts */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractWebDocument, WEB_EXTRACTION_VERSION } from "../src/web-document.js";
import { JSDOM, VirtualConsole } from "jsdom";
import { fetchReferences, planLink, webReferenceNeedsUpgrade } from "../src/links.js";
import { updateReferenceCoverage } from "../src/reference-content.js";
import type { Thread, TweetNode } from "../src/types.js";

const prose = "This is the substantive article describing a repeatable method with evidence, useful results, and careful verification of the original sources. ".repeat(6);
const html = `<!doctype html><html><head><title>Original report</title><link rel="canonical" href="/canonical"></head><body>
<nav>${"Navigation advertisements ".repeat(100)}</nav><article><h1>Actual report</h1><p>${prose}</p>
<p>See <a href="../methods">the method</a> and <a href="javascript:alert(1)">unsafe link</a>.</p>
<pre><code class="language-typescript">const n = 1;\nconsole.log(n);</code></pre>
<table><thead><tr><th>Method</th><th>Score</th></tr></thead><tbody><tr><td>Hybrid</td><td>0.95</td></tr></tbody></table>
<ul><li>First finding</li><li>Second finding</li></ul></article><footer>Not the article</footer></body></html>`;
const extracted = extractWebDocument(html, "https://publisher.example/reports/new");
assert.match(extracted.text, /\[the method\]\(https:\/\/publisher.example\/methods\)/);
assert.match(extracted.text, /```(?:typescript)?\nconst n = 1;/);
assert.match(extracted.text, /\| Method \| Score \|/);
assert.match(extracted.text, /0\.95/);
assert.doesNotMatch(extracted.text, /Navigation advertisements|Not the article|javascript:/);
assert.equal(extracted.canonicalUrl, "https://publisher.example/canonical");
assert.equal(extracted.warning, undefined);
assert.throws(() => extractWebDocument(`<title>Just a moment...</title><body>${prose}</body>`, "https://example.com"), /challenge page/);
assert.match(extractWebDocument(`<title>Paid report</title><article>${prose}<div class="paywall">Subscribe to read more</div></article>`, "https://example.com").warning!, /paywall/);
const imageArticle = extractWebDocument(`<article><p>${prose}</p><img src="/figure.png" alt="Results chart"></article>`, "https://example.com/post");
assert.deepEqual(imageArticle.imageUrls, ["https://example.com/figure.png"]);
assert.equal(imageArticle.images[0].altText, "Results chart");
assert.match(imageArticle.text, /\[\[reference-image:[a-f0-9]{64}\]\]/);
assert.equal(imageArticle.warning, undefined);
const complex = extractWebDocument(`<article><h1>Data</h1><p>${prose}</p><table><tr><td colspan="2">Merged data</td></tr></table></article>`, "https://example.com");
assert.match(complex.text, /<table>/);
assert.match(complex.text, /colspan="2"/);

// The unsupported stylesheet must exercise JSDOM's actual CSS diagnostic,
// while production extraction avoids emitting either the diagnostic or CSS.
const brokenCss = 'body { color: "unterminated; }';
const diagnostics: string[] = [];
const diagnosticConsole = new VirtualConsole();
diagnosticConsole.on("jsdomError", (error: Error & { type?: string }) => diagnostics.push(error.type ?? ""));
new JSDOM(`<style>${brokenCss}</style>`, { virtualConsole: diagnosticConsole }).window.close();
assert.ok(diagnostics.some((type) => /^css[ -]parsing$/.test(type)), "Fixture must trigger CSS parsing diagnostic");
const stderrMessages: unknown[][] = [];
const originalConsoleError = console.error;
try {
  console.error = (...args) => { stderrMessages.push(args); };
  assert.match(extractWebDocument(`<style>${brokenCss}</style><article>${prose}</article>`, "https://example.com").text, /substantive article/);
} finally { console.error = originalConsoleError; }
assert.deepEqual(stderrMessages, [], "Unsupported CSS must not dump stylesheet diagnostics");

const tweet = (id: string, handle: string, text: string): TweetNode => ({
  id, author: { handle, name: handle }, text, url: `https://x.com/${handle}/status/${id}`,
  createdAtRaw: "", metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0 }, media: [], isMainTweet: id === "1",
});
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tweetmd-web-documents-"));
const realFetch = globalThis.fetch;
const requests: string[] = [];
try {
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://api.github.com/repos/example/repo/contents/plugins/ralph-wiggum?ref=main") return Response.json([
      { name: "readme.md", path: "plugins/ralph-wiggum/readme.md", type: "file" },
      { name: "plugin.json", path: "plugins/ralph-wiggum/plugin.json", type: "file" },
    ]);
    if (url === "https://raw.githubusercontent.com/example/repo/main/plugins/ralph-wiggum/readme.md") return new Response("# Ralph plugin\nSubtree-specific instructions.");
    if (url === "https://short.example/report") return new Response(null, { status: 302, headers: { location: "https://publisher.example/reports/new" } });
    if (url === "https://publisher.example/reports/new") return new Response(html, { headers: { "content-type": "text/html" } });
    if (url === "https://arxiv.org/html/2409.06203v1") return new Response(html, { headers: { "content-type": "text/html" } });
    if (url === "https://arxiv.org/abs/2409.06204") return new Response(`<article><h1>Abstract</h1><p>${prose}</p></article>`, { headers: { "content-type": "text/html" } });
    return new Response("not available", { status: 404 });
  };
  const main = tweet("1", "author", "https://short.example/report https://arxiv.org/abs/2409.06203v1 https://arxiv.org/abs/2409.06204 https://youtu.be/abcdefghijk");
  const reply = tweet("2", "other", "https://github.com/example/example");
  const thread: Thread = { main, ancestors: [], replies: [reply], capturedAt: "", sourceUrl: main.url };
  await fetchReferences(thread, dir);
  const refs = thread.references!;
  assert.equal(refs[0].finalUrl, "https://publisher.example/reports/new");
  assert.equal(refs[0].canonicalUrl, "https://publisher.example/canonical");
  assert.equal(refs[0].title, "Original report");
  assert.equal(refs[0].status, "complete");
  assert.equal(refs[0].extractionVersion, WEB_EXTRACTION_VERSION);
  assert.equal(refs[0].provenance, "author");
  assert.equal(refs[1].resolution, "full-text");
  assert.equal(refs[2].resolution, "abstract-only");
  assert.equal(refs[2].status, "partial");
  assert.match(refs[2].warning!, /saved abstract only/);
  assert.equal(refs[3].status, "partial");
  assert.match(refs[3].warning!, /transcript.*(?:pending|unavailable)/);
  assert.equal(refs[4].provenance, "reply");
  assert.equal(refs[4].status, "failed");
  assert.ok(!requests.some((url) => url.includes("youtu.be")));
  assert.equal(planLink("https://arxiv.org/pdf/2409.06203v1.pdf")?.kind, "web");
  assert.equal(planLink("https://arxiv.org/abs/not-a-paper")?.kind, "web");

  const directory = await planLink("https://github.com/example/repo/tree/main/plugins/ralph-wiggum")!.fetch();
  assert.match(directory[0].text, /Subtree-specific instructions/);
  assert.ok(!requests.some((url) => url === "https://github.com/example/repo/tree/main/plugins/ralph-wiggum"));
  assert.equal(planLink("http://CLAUDE.md's"), null);
  assert.ok(planLink("https://claude.md"), "Real .md domains remain valid");

  const legacyRefs = [refs[0], refs[1]].map((ref) => ({ ...ref, status: undefined,
    extractionVersion: undefined, extractionMethod: undefined, finalUrl: undefined }));
  const legacyThread: Thread = { ...thread, replies: [], references: legacyRefs };
  requests.length = 0;
  await fetchReferences(legacyThread, dir, { resume: true });
  assert.ok(requests.includes("https://short.example/report"), "Legacy regex captures require re-extraction");
  assert.ok(requests.includes("https://arxiv.org/html/2409.06203v1"), "Legacy arXiv abstract cannot stand in for full text");
  assert.equal(legacyThread.references![0].extractionVersion, WEB_EXTRACTION_VERSION);
  assert.equal(legacyThread.references![1].resolution, "full-text");
  assert.equal(webReferenceNeedsUpgrade({ ...refs[1], finalUrl: "https://arxiv.org/abs/2409.06203v1" }), true);

  await fs.writeFile(path.join(dir, "supplement.md"), "Manual full text");
  refs.push({ url: "https://publisher.example/manual", kind: "web", sourceTweetId: "1", title: "Supplement",
    files: [{ localPath: "supplement.md", bytes: 16 }], status: "complete" });
  requests.length = 0;
  await fetchReferences(thread, dir, { resume: true });
  assert.ok(!requests.includes("https://short.example/report"), "Complete references are reused");
  assert.ok(!requests.includes("https://arxiv.org/html/2409.06203v1"));
  assert.ok(requests.includes("https://arxiv.org/html/2409.06204"), "Abstract-only references retry full text");
  assert.ok(thread.references!.some((ref) => ref.title === "Supplement"));
  assert.equal(await fs.readFile(path.join(dir, "supplement.md"), "utf8"), "Manual full text");

  // A failed retry keeps a previous partial source's file and marks it partial.
  globalThis.fetch = async () => new Response("no", { status: 404 });
  const failedLegacy: Thread = { ...thread, replies: [], references: [legacyRefs[0]] };
  await fetchReferences(failedLegacy, dir, { resume: true });
  const retainedLegacy = failedLegacy.references![0];
  assert.equal(retainedLegacy.status, "partial");
  assert.equal(retainedLegacy.resolution, "unknown");
  assert.equal(retainedLegacy.extractionVersion, undefined);
  assert.match(retainedLegacy.warning!, /completeness is unknown/);
  assert.ok(retainedLegacy.files.length, "Failed legacy upgrades retain useful previous files");
  assert.equal(await fs.readFile(path.join(dir, retainedLegacy.files[0].localPath), "utf8"), extracted.text);
  await fetchReferences(thread, dir, { resume: true });
  const partial = thread.references!.find((ref) => ref.resolution === "abstract-only" || ref.warning?.includes("retained previous"));
  assert.ok(partial?.files.length);
  assert.equal(partial.status, "partial");
  assert.match(partial.warning!, /retained previous/);
  const invalidEmpty = { url: "http://CLAUDE.md's", kind: "web" as const, sourceTweetId: "1",
    title: "Obsolete prose link", status: "failed" as const, files: [], error: "fetch failed" };
  const invalidWithCopy = { ...invalidEmpty, title: "Historical copy", files: [{ localPath: "supplement.md", bytes: 16 }] };
  const video = { url: "https://youtu.be/abcdefghijk", kind: "web" as const, sourceTweetId: "1", title: "Video",
    status: "skipped" as const, warning: "Video transcript not captured", files: [] };
  const noLinks = { ...thread, main: tweet("1", "author", "No outbound links"), replies: [],
    references: [invalidEmpty, invalidWithCopy, video] };
  await fetchReferences(noLinks, dir, { resume: true });
  assert.deepEqual(noLinks.references!.map((ref) => ref.title), ["Historical copy", "Video"]);
  assert.equal(await fs.readFile(path.join(dir, "supplement.md"), "utf8"), "Manual full text");
  noLinks.references = [invalidEmpty];
  await fetchReferences(noLinks, dir, { resume: true });
  assert.deepEqual(noLinks.references, [], "Pruning the last obsolete discovery must update the thread");
  await fetchReferences(thread, dir, { resume: true });
  const retried = thread.references!.find((ref) => ref.url === partial.url)!;
  assert.equal((retried.warning!.match(/Retry failed; retained previous source copy/g) ?? []).length, 1, "Repeated retries must not grow duplicate warning prefixes");
  // Coverage prefixes errors before saving; the next retry must not treat
  // that runtime report as a fresh extraction warning.
  updateReferenceCoverage(retried);
  await fetchReferences(thread, dir, { resume: true });
  const afterCoverage = thread.references!.find((ref) => ref.url === partial.url)!;
  updateReferenceCoverage(afterCoverage);
  assert.equal((afterCoverage.warning!.match(/Retry failed; retained previous source copy/g) ?? []).length, 1);
  assert.equal(afterCoverage.warning!.split(afterCoverage.error!).length - 1, 1);
  console.log("Web document extraction, full-paper resolution, provenance, and resume checks passed");
} finally {
  globalThis.fetch = realFetch;
  await fs.rm(dir, { recursive: true, force: true });
}
