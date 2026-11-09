/** Run with: npx tsx scripts/test-classification-context.ts */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classificationContext } from "../src/categorize.js";
import type { Thread, TweetNode } from "../src/types.js";

const tweet = (id: string, handle: string, text: string): TweetNode => ({
  id, author: { handle, name: handle }, text, url: `https://x.com/${handle}/status/${id}`,
  createdAtRaw: "", metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0 },
  media: [], isMainTweet: id === "1",
});
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tweetmd-context-"));
try {
  await fs.mkdir(path.join(dir, "refs"));
  await fs.writeFile(path.join(dir, "refs/article.md"), "Article substance: retrieval quality");
  const thread: Thread = {
    main: tweet("1", "Author", "Read this"), ancestors: [],
    replies: [tweet("2", "author", "Author follow-up"), tweet("3", "Other", "Unrelated reply")],
    references: [{ sourceTweetId: "1", url: "https://example.com", title: "Article",
      kind: "web", files: [{ localPath: "refs/article.md", bytes: 44 }] }],
    capturedAt: "", sourceUrl: "https://x.com/Author/status/1",
  };
  thread.main.media.push({ url: "https://example.com/chart.jpg", type: "photo", enrichment: { kind: "text", content: "Chart-only substantive content" } });
  const context = await classificationContext(thread, dir);
  assert.match(context, /Chart-only substantive content/);
  assert.match(context, /retrieval quality/);
  assert.match(context, /Author follow-up/);
  assert.doesNotMatch(context, /Unrelated reply/);
  thread.main.text = "x".repeat(100_000);
  thread.replies.push(...Array.from({ length: 8 }, (_, i) => tweet(String(i + 4), "Author", "y".repeat(4000))));
  const bounded = await classificationContext(thread, dir);
  assert.ok(bounded.length <= 24_000);
  assert.match(bounded, /retrieval quality/, "Long threads must leave room for linked sources");
  thread.references![0].files[0].localPath = "../outside.md";
  assert.doesNotMatch(await classificationContext(thread, dir), /retrieval quality/);
  thread.references![0].sourceTweetId = "3";
  assert.doesNotMatch(await classificationContext(thread, dir), /Linked source/);
  console.log("Classification context checks passed");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
