import "./fixtures/public-dns.js";
/** Public transcript fixtures: npx tsx scripts/test-transcripts.ts */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CAPTION_PARSER_VERSION, fetchVideoTranscript, formatTranscriptMarkdown, parseCaptionSegments, selectCaptionTracks, youtubeVideoId } from "../src/transcripts.js";
const id = "hdZY2T8o4M4";
const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello &amp; welcome\n\n00:00:03.000 --> 00:00:05.500\n<c>Captions</c> are available.\n";
for (const url of [`https://youtu.be/${id}?si=abc`, `https://youtube.com/watch?v=${id}&list=anything`, `https://m.youtube.com/watch?v=${id}`, `https://www.youtube.com/shorts/${id}`, `https://youtube.com/live/${id}`, `https://youtube-nocookie.com/embed/${id}`]) assert.equal(youtubeVideoId(url), id);
assert.equal(youtubeVideoId(`https://youtube.com.evil.test/watch?v=${id}`), null);
assert.equal(youtubeVideoId("https://youtube.com/watch?v=bad"), null);
assert.deepEqual(parseCaptionSegments(vtt), [{ startSeconds: 1, endSeconds: 3, text: "Hello & welcome" }, { startSeconds: 3, endSeconds: 5.5, text: "Captions are available." }]);
assert.deepEqual(parseCaptionSegments('<transcript><text start="1.25" dur="2.5">Fish &amp; chips</text></transcript>'), [{ startSeconds: 1.25, endSeconds: 3.75, text: "Fish & chips" }]);
assert.deepEqual(parseCaptionSegments('<tt><body><div><p begin="1500ms" end="3s">First<br/>second</p></div></body></tt>'), [{ startSeconds: 1.5, endSeconds: 3, text: "First second" }]);
assert.deepEqual(parseCaptionSegments('<timedtext format="3"><body><p t="1500" d="2200"><s>Real timestamp</s></p></body></timedtext>'), [{ startSeconds: 1.5, endSeconds: 3.7, text: "Real timestamp" }]);
assert.deepEqual(parseCaptionSegments('<timedtext format="2"><text t="0" d="1000">Start at zero</text></timedtext>'), [{ startSeconds: 0, endSeconds: 1, text: "Start at zero" }]);
assert.deepEqual(parseCaptionSegments('<transcript><text start="0" dur="0">Explicit zero</text></transcript>'), [{ startSeconds: 0, endSeconds: 0, text: "Explicit zero" }]);
for (const xml of ['<tt><p>Missing times</p></tt>', '<tt><p begin="" dur="2">Empty start</p></tt>', '<tt><p begin="0">Missing end</p></tt>', '<tt><p begin="bogus" end="3">Invalid start</p></tt>', '<tt><p begin="00:99" end="01:00">Invalid clock</p></tt>', '<timedtext><p t="" d="2000">Invalid milliseconds</p></timedtext>']) assert.deepEqual(parseCaptionSegments(xml), []);
assert.deepEqual(parseCaptionSegments(JSON.stringify({ events: [{ tStartMs: null, dDurationMs: 1000, segs: [{ utf8: "Missing start" }] }, { tStartMs: 0, segs: [{ utf8: "Missing duration" }] }] })), []);
assert.deepEqual(parseCaptionSegments(JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: "Hello" }] }, { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: "Hello world" }] }] })), [{ startSeconds: 0, endSeconds: 5, text: "Hello world" }]);
assert.deepEqual(selectCaptionTracks([
  { url: "de", language: "de", automatic: true }, { url: "en-auto", language: "en", automatic: true },
  { url: "fr-human", language: "fr", automatic: false }, { url: "en-human", language: "en-US", automatic: false },
]).map((track) => track.url), ["en-human", "en-auto", "fr-human", "de"]);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tweetmd-transcript-test-"));
try {
  const calls: string[] = [];
  const transcript = await fetchVideoTranscript(`https://youtu.be/${id}`, {
    captionTracks: [{ url: "https://www.youtube.com/api/timedtext?human", language: "en", automatic: false }, { url: "https://www.youtube.com/api/timedtext?auto", language: "en", automatic: true }],
    fetch: (async (url) => { calls.push(String(url)); return new Response(vtt, { status: String(url).endsWith("human") ? 403 : 200 }); }) as typeof fetch,
  });
  assert.equal(transcript.status, "complete");
  assert.equal(transcript.parserVersion, CAPTION_PARSER_VERSION);
  assert.match(formatTranscriptMarkdown(transcript), /Parser: timed-captions-v2/);
  assert.equal(transcript.automatic, true);
  assert.equal(transcript.language, "en");
  assert.equal(calls.length, 2);
  assert.match(formatTranscriptMarkdown(transcript), /\[00:00:01–00:00:03\] Hello & welcome/);
  const untimed = await fetchVideoTranscript(`https://youtu.be/${id}`, { captionTracks: [{ url: "https://www.youtube.com/api/timedtext?untimed", language: "en" }], fetch: (async () => new Response('<tt><p>Readable words without any timing</p></tt>')) as typeof fetch });
  assert.equal(untimed.status, "unavailable", "Untimed XML cannot produce a complete timestamped transcript");
  assert.equal(untimed.segments.length, 0);
  const truncated = await fetchVideoTranscript("https://x.com/i/status/123", { captionTracks: [{ url: "https://video.twimg.com/captions.vtt", language: "en", automatic: false }], fetch: (async () => new Response(vtt)) as typeof fetch, maxCharacters: 5 });
  assert.equal(truncated.status, "partial");
  assert.equal(truncated.text, "Hello");
  assert.equal(truncated.segments[0].startSeconds, 1);
  const denied = await fetchVideoTranscript("https://x.com/i/status/123", { captionTracks: [{ url: "https://video.twimg.com/captions.vtt" }], fetch: (async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secrets" } })) as typeof fetch });
  assert.equal(denied.status, "unavailable");
  assert.match(denied.error!, /supported public caption host/);
  const missing = await fetchVideoTranscript("https://example.com/arbitrary-video");
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.parserVersion, CAPTION_PARSER_VERSION);
  assert.match(missing.error!, /Unsupported/);
  const originalFetch = globalThis.fetch;
  try {
    const publicCalls: string[] = [];
    globalThis.fetch = (async (url) => {
      publicCalls.push(String(url));
      if (String(url).endsWith("/huge.vtt")) return new Response("x".repeat(4 * 1024 * 1024 + 1));
      if (String(url).endsWith("/redirect.vtt")) return new Response(null, { status: 302, headers: { location: "http://localhost/private.vtt" } });
      return new Response(vtt, { headers: { "content-type": "text/vtt" } });
    }) as typeof fetch;
    const publicTrack = { url: "https://publisher.example/talk.vtt", language: "en", automatic: false };
    const defaultDenied = await fetchVideoTranscript("https://publisher.example/talk", { captionTracks: [publicTrack] });
    assert.equal(defaultDenied.status, "unavailable", "Generic hosts require explicit HTML-track authorization");
    assert.equal(publicCalls.length, 0);
    const generic = await fetchVideoTranscript("https://publisher.example/talk.mp4", { captionTracks: [publicTrack], allowPublicCaptionTracks: true });
    assert.equal(generic.status, "complete");
    assert.equal(generic.provider, "caption-track");
    assert.match(generic.text, /Hello & welcome/);
    assert.equal(publicCalls.length, 1);
    const local = await fetchVideoTranscript("https://publisher.example/talk", { captionTracks: [{ url: "http://localhost/private.vtt" }], allowPublicCaptionTracks: true });
    assert.equal(local.status, "unavailable");
    assert.equal(publicCalls.length, 1, "Local caption URLs must be rejected before any fetch");
    const redirected = await fetchVideoTranscript("https://publisher.example/talk", { captionTracks: [{ url: "https://publisher.example/redirect.vtt" }], allowPublicCaptionTracks: true });
    assert.equal(redirected.status, "unavailable");
    assert.equal(publicCalls.length, 2, "Private redirect targets must never be fetched");
    const huge = await fetchVideoTranscript("https://publisher.example/talk", { captionTracks: [{ url: "https://publisher.example/huge.vtt" }], allowPublicCaptionTracks: true });
    assert.equal(huge.status, "unavailable");
    assert.match(huge.error!, /size limit/);
  } finally { globalThis.fetch = originalFetch; }
  // Metadata retrieval uses isolated yt-dlp, without downloading files or loading user config.
  const bin = path.join(dir, "fake-yt-dlp");
  const log = path.join(dir, "args");
  const metadata = JSON.stringify({ title: "Fixture interview", subtitles: { en: [{ ext: "vtt", url: "https://www.youtube.com/api/timedtext?fixture" }] }, automatic_captions: {} });
  await fs.writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nprintf '%s' '${metadata}'\n`, { mode: 0o700 });
  const fetched = await fetchVideoTranscript(`https://youtu.be/${id}?list=anything`, { ytDlpBin: bin, fetch: (async () => new Response(vtt)) as typeof fetch });
  assert.equal(fetched.status, "complete");
  assert.equal(fetched.title, "Fixture interview");
  assert.equal(fetched.automatic, false);
  const args = (await fs.readFile(log, "utf8")).trim().split("\n");
  assert.ok(args.includes("--skip-download"));
  assert.ok(args.includes("--ignore-config"));
  assert.ok(args.includes("--no-plugin-dirs"));
  assert.ok(args.includes("--no-remote-components"));
  assert.equal(args[args.length - 2], "--");
  assert.equal(args[args.length - 1], `https://www.youtube.com/watch?v=${id}`);
  await fs.writeFile(bin, "#!/bin/sh\nprintf '%s' '{\"subtitles\":{},\"automatic_captions\":{}}'\n", { mode: 0o700 });
  assert.match((await fetchVideoTranscript(`https://youtu.be/${id}`, { ytDlpBin: bin })).error!, /No public human or automatic/);
  await fs.writeFile(bin, "#!/bin/sh\nprintf '%s' 'Sign in to confirm you are not a bot' >&2\nexit 1\n", { mode: 0o700 });
  assert.match((await fetchVideoTranscript(`https://youtu.be/${id}`, { ytDlpBin: bin })).error!, /not publicly available/);
  assert.throws(() => parseCaptionSegments("x".repeat(4 * 1024 * 1024 + 1)), /size limit/);
  console.log("Public captions, selection, timestamp, bound and unavailable-transcript checks passed");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
