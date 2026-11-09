/** Run with: pnpm exec tsx scripts/test-render-transcripts.ts */
import assert from "node:assert/strict";
import { renderTweetDoc } from "../src/render.js";
import type { Thread } from "../src/types.js";
import type { VideoTranscript } from "../src/transcripts.js";

const transcript: VideoTranscript = {
  status: "complete", sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk", provider: "youtube",
  language: "en", automatic: false, fetchedAt: "2026-11-05T00:00:00Z", text: "A useful explanation.",
  segments: [{ startSeconds: 0, endSeconds: 2, text: "A useful explanation." }],
};
const thread: Thread = {
  main: { id: "123", url: "https://x.com/test/status/123", author: { name: "Test", handle: "test" },
    text: "Watch the demo", createdAtRaw: "", media: [{ url: "https://pbs.twimg.com/poster.jpg", type: "video",
      localPath: "media/poster.jpg", transcript: { ...transcript, provider: "x" },
      transcriptFile: { localPath: "media/native-captions.md", bytes: 123 } }], isMainTweet: true,
    metrics: { likes: 0, replies: 0, retweets: 0, quotes: 0 } }, ancestors: [], replies: [],
  capturedAt: "2026-11-05T00:00:00Z", sourceUrl: "https://x.com/test/status/123",
  references: [{ url: transcript.sourceUrl, kind: "video", title: "Useful demo", sourceTweetId: "123",
    status: "complete", provenance: "author", transcript,
    files: [{ localPath: "refs/demo-captions.md", bytes: 456 }],
    warning: "Video link retained without a transcript." }],
};
let rendered = renderTweetDoc(thread);
assert.match(rendered, /!\[tweet image\]\(media\/poster.jpg\)/, "Native video keeps its poster");
assert.match(rendered, /\[Saved captions\]\(media\/native-captions.md\)/);
assert.match(rendered, /\[Saved captions\]\(refs\/demo-captions.md\)/);
assert.match(rendered, /complete · youtube · en · human-provided captions · 1 timestamped segment/);
assert.match(rendered, /Fetched: 2026-11-05T00:00:00Z/);
assert.doesNotMatch(rendered, /without a transcript|captions not captured|fetch failed/, "Successful captions must not be described as missing");

thread.main.media[0].transcript = undefined;
assert.doesNotMatch(renderTweetDoc(thread), /captions not captured/, "Legacy saved caption files remain discoverable even without provenance");
thread.main.media[0].transcript = { ...transcript, status: "partial", automatic: true, truncated: true, error: "Character limit reached." };
thread.references![0].transcript = { ...transcript, status: "unavailable", text: "", segments: [], error: "No public captions available." };
thread.references![0].status = "partial";
thread.references![0].files = [];
rendered = renderTweetDoc(thread);
assert.match(rendered, /partial · youtube · en · automatic captions/);
assert.match(rendered, /Caption text was truncated/);
assert.match(rendered, /No public captions available/);
assert.doesNotMatch(rendered, /fetch failed/, "Unavailable captions have a specific failure reason");

thread.main.media = [];
thread.references = [{ url: "https://example.com/article", kind: "web", title: "An illustrated article", sourceTweetId: "123", status: "partial",
  files: [{ localPath: "refs/article.md", bytes: 1234 }],
  media: [{ type: "photo", url: "https://example.com/figure.png", localPath: "refs/media/figure.png", enrichment: { kind: "text", description: "A chart", content: "Chart data." } },
    { type: "photo", url: "https://example.com/missing.png", downloadError: "Image request failed." }],
  videos: [{ url: transcript.sourceUrl, transcript, file: { localPath: "refs/embedded-captions.md", bytes: 321 } }] }];
rendered = renderTweetDoc(thread);
assert.match(rendered, /Article images: 1\/2 saved · 1\/2 with OCR\/analysis/);
assert.match(rendered, /Image request failed/);
assert.match(rendered, /\[saved copy\]\(refs\/article.md\)/);
assert.match(rendered, /\[Saved captions\]\(refs\/embedded-captions.md\)/);
assert.doesNotMatch(rendered, /captions not captured|without a transcript/);
console.log("Video caption provenance, unavailable captions and linked article media rendering passed");
