/** Run with: npx tsx scripts/test-source-links.ts */
import assert from "node:assert/strict";
import { collectLinks, planLink } from "../src/links.js";
import { classificationContext } from "../src/categorize.js";
import type { Thread, TweetNode } from "../src/types.js";
const tweet = (id: string, handle: string, text: string): TweetNode => ({
  id, author: { handle, name: handle }, text, url: `https://x.com/${handle}/status/${id}`,
  createdAtRaw: "", metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0 }, media: [], isMainTweet: id === "1",
});
const main = tweet("1", "author", "See this source");
main.quoted = tweet("2", "source", "Evidence: https://example.com/article");
main.embeddedTweets = [tweet("3", "source", "https://example.com/embedded")];
const reply = tweet("4", "stranger", "https://example.com/noise");
reply.quoted = tweet("5", "other", "https://example.com/quoted-noise");
const thread: Thread = { main, ancestors: [], replies: [reply], capturedAt: "", sourceUrl: main.url };
assert.deepEqual(collectLinks(thread, false).map((link) => link.url), [
  "https://example.com/article", "https://example.com/embedded",
]);
assert.equal(collectLinks(thread, true).length, 4);
assert.match(await classificationContext(thread), /Evidence:/);
assert.doesNotMatch(await classificationContext(thread), /quoted-noise/);
assert.equal(planLink("https://github.com/example/repo/blob/main/diagram.png"), null);
assert.ok(planLink("https://github.com/example/repo/blob/main/README.md"));
console.log("Quoted and embedded source checks passed");
