/**
 * Render a captured Thread into the output bundle:
 *   tweet.md    — human-readable Markdown
 *   thread.json — structured data for programmatic / Claude consumption
 *   CLAUDE.md   — orientation file so another Claude session can analyze the folder
 */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { captureSummary, finalizeCapture, newCaptureReport, setStage } from "./capture.js";
import { acquireLease } from "./lock.js";
import { preflightClaude, type ProviderStatus } from "./provider.js";
import path from "node:path";
import { enrichImages, isValidEnrichment, type EnrichOptions } from "./enrich.js";
import { pruneDecorativeMedia } from "./media.js";
import { allTweets } from "./x-parse.js";
import type { VideoTranscript } from "./transcripts.js";
import type { ImageEnrichment, MediaItem, SavedFile, Thread, TweetNode } from "./types.js";

function fmtDate(node: TweetNode): string {
  if (node.createdAt) {
    return new Date(node.createdAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
  return node.createdAtRaw || "unknown date";
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${fmtNum(n)} ${n === 1 ? singular : pluralForm}`;
}

function metricsLine(node: TweetNode): string {
  const m = node.metrics;
  const parts = [
    `❤ ${fmtNum(m.likes)}`,
    `🔁 ${fmtNum(m.retweets)}`,
    `💬 ${plural(m.replies, "reply", "replies")}`,
    `❝ ${plural(m.quotes, "quote")}`,
  ];
  if (m.views != null) parts.push(`👁 ${plural(m.views, "view")}`);
  if (m.bookmarks != null) parts.push(`🔖 ${fmtNum(m.bookmarks)}`);
  return parts.join(" · ");
}

/** Best human-readable alt text for an image link. */
function altFor(m: MediaItem): string {
  return m.altText ?? m.enrichment?.description ?? "tweet image";
}

/**
 * True when the enrichment already carries an accurate text rendering of the
 * image — a Mermaid diagram, a Markdown table, or a faithful transcription
 * (any non-decorative `content`). Embedding the source image as well would just
 * duplicate it, so we drop the image and keep the rendering.
 */
function hasOwnRendering(e: ImageEnrichment | undefined): boolean {
  return !!e?.content;
}

/**
 * Render an image's analysis as an inline block: a good alt-text link (only
 * when a path is supplied), the author alt-text, the description, and the
 * ready-to-embed `content` (mermaid / table / transcription).
 */
function enrichedBlock(m: MediaItem, pathInText: string | null): string {
  const e = m.enrichment;
  const alt = altFor(m);
  // Decorative images are dropped (file + embed); only the description remains.
  // When we have our own Mermaid rendering, drop the duplicate source image too.
  const showImage = !!pathInText && e?.kind !== "decorative" && !hasOwnRendering(e);
  const lines: string[] = [];
  if (showImage) lines.push(`![${alt}](${pathInText})`);
  if (m.altText) lines.push(`*Author alt-text:* ${m.altText}`);
  // Skip the description line when it's already serving as a shown image's alt text.
  if (e?.description && !(showImage && e.description === alt)) {
    lines.push(`*Description:* ${e.description}`);
  }
  if (m.downloadError) lines.push(`*Image download unavailable:* ${m.downloadError}`);
  if (!e && m.enrichmentError) lines.push(`*Image analysis unavailable:* ${m.enrichmentError}`);
  if (!e && m.enrichmentSkipped) lines.push(`*Image analysis skipped:* ${m.enrichmentSkipped}`);
  if (e?.content) lines.push(e.content);
  if (m.type === "video") lines.push(transcriptBlock(m.transcript, m.transcriptFile));
  return lines.join("\n\n");
}

/** Caption provenance is distinct from a video poster's image analysis. */
function transcriptBlock(transcript: VideoTranscript | undefined, file?: SavedFile): string {
  if (!transcript) return file
    ? `*Video captions:* saved; language and caption provenance unavailable.\n\n[Saved captions](${file.localPath}) (${fmtBytes(file.bytes)})`
    : "*Video captions not captured.*";
  const captions = transcript.automatic === true ? "automatic captions"
    : transcript.automatic === false ? "human-provided captions" : "caption origin unknown";
  const details = [transcript.status, transcript.provider, transcript.language ?? "language unknown", captions,
    plural(transcript.segments.length, "timestamped segment")];
  const lines = [`*Video captions:* ${details.join(" · ")}`,
    `Source: <${transcript.sourceUrl}>`, `Fetched: ${transcript.fetchedAt}`];
  if (file) lines.push(`[Saved captions](${file.localPath}) (${fmtBytes(file.bytes)}${file.truncated ? ", truncated" : ""})`);
  else if (transcript.text.trim()) lines.push(transcript.text);
  if (transcript.truncated) lines.push("> Caption text was truncated; this transcript is partial.");
  if (transcript.error) lines.push(`> Caption ${transcript.status === "unavailable" ? "unavailable" : "capture warning"}: ${transcript.error}`);
  else if (transcript.status === "unavailable") lines.push("> No public caption track was available; audio transcription was not attempted.");
  return lines.join("\n\n");
}

/**
 * For X Articles, the body already contains `![article image](path)`
 * placeholders at the images' real positions. Replace each, in order, with the
 * enriched block so a text-only reader gets the diagram/table/transcription
 * exactly where it belongs instead of detached at the end of the file.
 */
function articleBodyWithMedia(node: TweetNode): string {
  const inline = node.media.filter((m) => m.inline);
  // Keyed by `articleIndex` (the item's original media_entities position), not
  // array position — some media_entities are skipped (no resolvable image URL),
  // which shifts `inline`'s array indices away from the original ones baked
  // into each placeholder's path.
  const inlineByIdx = new Map(inline.filter((m) => m.articleIndex != null).map((m) => [m.articleIndex!, m]));
  let seq = 0;
  const withMedia = node.text.replace(/!\[article image\]\(([^)]*)\)/g, (full, p: string) => {
    // The placeholder path is media/<id>-<idx>.<ext>; <idx> is the
    // media_entities index. Match by that identity, not appearance order —
    // body image order can differ from media_entities order, which would
    // otherwise splice the wrong analysis.
    const idx = p.match(/-(\d+)(?:\.[^./]+)?$/);
    const m = (idx ? inlineByIdx.get(Number(idx[1])) : undefined) ?? inline[seq];
    seq++;
    return m ? enrichedBlock(m, m.localPath ?? (m.enrichment?.kind === "decorative" ? null : m.url)) : `> Missing article image: ${p}`;
  });

  // Same idea for tweets the article embeds inline — `article.ts` leaves a
  // `[[embedded-tweet:ID]]` marker where resolution failed (fetch skipped or
  // the source tweet was deleted); fall back to a bare link so the reference
  // survives rather than vanishing silently.
  const embedsById = new Map((node.embeddedTweets ?? []).map((t) => [t.id, t]));
  return withMedia.replace(/\[\[embedded-tweet:(\d+)\]\]/g, (_full, id: string) => {
    const embedded = embedsById.get(id);
    return embedded ? renderQuoted(embedded) : `> Embedded tweet: <https://x.com/i/status/${id}>`;
  });
}

function renderMedia(node: TweetNode): string {
  if (node.media.length === 0) return "";
  const out: string[] = [];
  node.media.forEach((m, i) => {
    // Inline (article) images are rendered in the body by articleBodyWithMedia,
    // so don't repeat them here.
    if (m.inline) return;

    const e = m.enrichment;
    const decorative = e?.kind === "decorative";
    const kindNote = e?.kind ? ` — ${e.kind}` : "";
    const typeNote =
      m.type !== "photo" ? ` (${m.type}${m.localPath ? " poster frame" : ""})` : "";
    out.push(`\n**${m.type === "video" ? "Video" : "Image"} ${i + 1}**${typeNote}${kindNote}`);
    // Drop the image when it's decorative, or when we have our own accurate
    // rendering of it (diagram/table/transcription) that would otherwise double.
    const embed = !decorative && !hasOwnRendering(e);
    const shown = embed && !!m.localPath;
    if (embed) {
      if (m.localPath) {
        out.push(`\n![${altFor(m)}](${m.localPath})`);
      } else {
        out.push(`\n<${m.url}>`);
      }
    }
    if (m.altText) out.push(`\n*Author alt-text:* ${m.altText}`);
    // Skip the description when it's already serving as the shown image's alt text.
    if (e?.description && !(shown && e.description === altFor(m))) {
      out.push(`\n*Description:* ${e.description}`);
    }
    // `content` is already ready-to-embed Markdown (mermaid fence, table, or transcription).
    if (m.downloadError) out.push(`\n*Image download unavailable:* ${m.downloadError}`);
    if (!e && m.enrichmentError) out.push(`\n*Image analysis unavailable:* ${m.enrichmentError}`);
    if (!e && m.enrichmentSkipped) out.push(`\n*Image analysis skipped:* ${m.enrichmentSkipped}`);
    if (e?.content) out.push(`\n${e.content}`);
    if (m.type === "video") out.push(`\n${transcriptBlock(m.transcript, m.transcriptFile)}`);
  });
  return out.length ? out.join("\n") + "\n" : "";
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

/**
 * Turn bare `@handle` mentions into links, leaving code fences, inline code,
 * existing Markdown links, and email addresses untouched. Applied to rendered
 * body text only (thread.json keeps the raw text).
 */
function linkifyMentions(md: string): string {
  const NUL = String.fromCharCode(0); // sentinel that can't occur in tweet text
  const stash: string[] = [];
  const hide = (s: string) => `${NUL}${stash.push(s) - 1}${NUL}`;
  const masked = md
    .replace(/```[\s\S]*?```/g, hide) // fenced code (incl. mermaid)
    .replace(/`[^`]*`/g, hide) // inline code
    .replace(/\[[^\]]*\]\([^)]*\)/g, hide) // existing [text](url) links
    .replace(
      // A handle not preceded by a word char, `@`, or `/` (so emails/paths are
      // skipped), and not immediately followed by a `.` + word char — that
      // pattern is a filename/domain suffix (`@AGENTS.md`, `@config.py`), not
      // an X mention trailing off at a sentence's end.
      /(^|[^\w@/])@([A-Za-z0-9_]{1,15})\b(?!\.\w)/g,
      (_m, pre: string, handle: string) => `${pre}[@${handle}](https://x.com/${handle})`,
    );
  return masked.replace(new RegExp(`${NUL}(\\d+)${NUL}`, "g"), (_m, i: string) => stash[Number(i)]);
}

function renderTweetBlock(node: TweetNode, heading: string): string {
  const lines: string[] = [];
  lines.push(heading);
  lines.push("");
  lines.push(`**${node.author.name}** ([@${node.author.handle}](https://x.com/${node.author.handle})) · [${fmtDate(node)}](${node.url})`);
  lines.push("");
  if (node.text) {
    // Articles are long-form Markdown — render verbatim, with image analysis
    // spliced in at each image's real position; short tweets are quoted.
    const body = node.isArticle ? articleBodyWithMedia(node) : quote(node.text);
    lines.push(linkifyMentions(body));
    lines.push("");
  }
  lines.push(metricsLine(node));
  const media = renderMedia(node);
  if (media) lines.push(media);
  if (node.quoted) {
    lines.push("");
    lines.push(renderQuoted(node.quoted));
  }
  return lines.join("\n");
}

/** Render a quoted tweet as a nested blockquote inside the quoting tweet. */
function renderQuoted(q: TweetNode): string {
  const inner: string[] = [];
  inner.push(
    `**Quoting ${q.author.name}** ([@${q.author.handle}](https://x.com/${q.author.handle})) · [${fmtDate(q)}](${q.url})`,
  );
  inner.push("");
  if (q.text) {
    inner.push(linkifyMentions(q.isArticle ? articleBodyWithMedia(q) : q.text));
    inner.push("");
  }
  inner.push(metricsLine(q));
  const media = renderMedia(q);
  if (media) inner.push(media);
  if (q.quoted) {
    inner.push("");
    inner.push(renderQuoted(q.quoted));
  }
  return blockquote(inner.join("\n"));
}

/**
 * Blockquote-wrap text, but leave fenced code blocks (```mermaid / ```) and
 * Markdown table rows un-prefixed — GitHub doesn't render those inside a `>`
 * quote, and a quoted tweet's value is often exactly that structured content.
 */
function blockquote(md: string): string {
  let inFence = false;
  return md
    .split("\n")
    .map((l) => {
      if (/^\s*```/.test(l)) {
        inFence = !inFence;
        return l;
      }
      if (inFence || /^\s*\|.*\|/.test(l)) return l;
      return l ? `> ${l}` : ">";
    })
    .join("\n");
}

/** YAML-escape a scalar (quote and escape if it could break the value). */
function yaml(value: string | number | undefined): string {
  if (value == null) return '""';
  if (typeof value === "number") return String(value);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Machine-readable header so consumers can read metadata without thread.json. */
function frontmatter(thread: Thread): string {
  const m = thread.main;
  const x = m.metrics;
  const lines = [
    "---",
    `id: ${yaml(m.id)}`,
    `url: ${yaml(m.url)}`,
    `source_url: ${yaml(thread.sourceUrl)}`,
    `author_handle: ${yaml(m.author.handle)}`,
    `author_name: ${yaml(m.author.name)}`,
    `created_at: ${yaml(m.createdAt ?? m.createdAtRaw)}`,
    `captured_at: ${yaml(thread.capturedAt)}`,
    `is_article: ${m.isArticle ? "true" : "false"}`,
    `capture_status: ${yaml(thread.capture?.status ?? "unknown")}`,
    `ancestors: ${thread.ancestors.length}`,
    `replies: ${thread.replies.length}`,
    `linked_sources: ${thread.references?.filter((r) => r.files.length > 0).length ?? 0}`,
    "metrics:",
    `  likes: ${x.likes}`,
    `  retweets: ${x.retweets}`,
    `  replies: ${x.replies}`,
    `  quotes: ${x.quotes}`,
  ];
  if (x.views != null) lines.push(`  views: ${x.views}`);
  if (x.bookmarks != null) lines.push(`  bookmarks: ${x.bookmarks}`);
  lines.push("---");
  return lines.join("\n");
}

/**
 * `tweet.md` — the author's own content only: their preceding self-thread
 * (ancestors), the main tweet, and any linked sources. The reply conversation
 * is split into `conversation.md` so this file stays a lean, focused payload
 * (e.g. for handing to Claude without dragging in every replier's noise). A
 * short pointer notes where the conversation lives.
 */
export function renderTweetDoc(thread: Thread): string {
  const m = thread.main;
  const out: string[] = [];

  out.push(frontmatter(thread));
  out.push("");
  out.push(`# Tweet by @${m.author.handle}`);
  out.push("");
  out.push(`> Source: ${thread.sourceUrl}  `);
  out.push(`> Captured: ${thread.capturedAt}`);
  out.push("");

  out.push(renderCaptureReport(thread));
  out.push("");

  if (thread.ancestors.length > 0) {
    out.push("## Thread context");
    out.push("");
    thread.ancestors.forEach((a, i) => {
      out.push(renderTweetBlock(a, `### ↑ Preceding tweet ${i + 1}`));
      out.push("\n---\n");
    });
  }

  out.push(renderTweetBlock(m, "## Main tweet"));
  out.push("");

  for (const link of thread.linkedTweets ?? []) {
    if (link.thread && !(m.embeddedTweets ?? []).some((node) => node.id === link.thread!.main.id)) {
      out.push(renderTweetBlock(link.thread.main, "## Linked tweet payload"));
      for (const followup of link.thread.replies) out.push(renderTweetBlock(followup, "### Linked author follow-up"));
    }
  }

  if (thread.replies.length > 0) {
    out.push("\n---\n");
    out.push("## Conversation");
    out.push("");
    out.push(
      `${plural(thread.replies.length, "reply", "replies")} captured in [\`conversation.md\`](conversation.md) — or press \`c\` to unfold in \`tweetmd read\`.`,
    );
    out.push("");
  }

  const refs = renderReferences(thread);
  if (refs) {
    out.push("\n---\n");
    out.push(refs);
  }

  return out.join("\n") + "\n";
}

/**
 * `conversation.md` — the reply conversation, split out of `tweet.md`. Returns
 * null when there are no replies (no file is written in that case). Media in
 * replies use the same bundle-root-relative `media/…` paths, so the file
 * renders correctly from the bundle directory just like `tweet.md`.
 */
export function renderConversationDoc(thread: Thread): string | null {
  if (thread.replies.length === 0) return null;
  const m = thread.main;
  const out: string[] = [];

  const fm = [
    "---",
    `parent_id: ${yaml(m.id)}`,
    `parent_url: ${yaml(m.url)}`,
    `author_handle: ${yaml(m.author.handle)}`,
    `replies: ${thread.replies.length}`,
    `captured_at: ${yaml(thread.capturedAt)}`,
    "---",
  ];
  out.push(fm.join("\n"));
  out.push("");
  out.push(`# Conversation — ${plural(thread.replies.length, "reply", "replies")}`);
  out.push("");
  out.push(
    `Replies to the [main tweet](tweet.md) by **${m.author.name}** ([@${m.author.handle}](https://x.com/${m.author.handle})).`,
  );
  out.push("");
  out.push("\n---\n");
  thread.replies.forEach((r) => {
    out.push(renderTweetBlock(r, `### 💬 @${r.author.handle}`));
    out.push("\n---\n");
  });

  return out.join("\n") + "\n";
}

/** Persisted coverage appears before content, including intentional omissions. */
export function renderCaptureReport(thread: Thread): string {
  if (!thread.capture) return "> Capture completeness has not been assessed for this legacy bundle.";
  const report = thread.capture;
  const lines = ["## Capture coverage", "", `**${captureSummary(thread)}**`, "", "| Stage | Result | Details |", "|---|---|---|"];
  for (const [name, stage] of Object.entries(report.stages)) {
    const message = (stage.message ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${name} | ${stage.status} | ${message} |`);
  }
  lines.push("", `${report.conversation.capturedReplies} replies captured; X reports ${report.conversation.reportedReplies}. Conversation completeness is **unknown**; counts are not a pagination guarantee.`);
  for (const warning of report.warnings) lines.push(`- ${warning}`);
  return lines.join("\n");
}

function fmtBytes(n: number | undefined): string {
  if (n == null) return "";
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** A section listing content fetched from links in the thread. */
function renderReferences(thread: Thread): string {
  const refs = (thread.references ?? []).filter((r) => r.files.length > 0 || r.error || r.warning || r.transcript || r.media?.length || r.videos?.length);
  if (refs.length === 0) return "";
  const lines: string[] = ["## Linked sources", ""];
  lines.push("Content fetched from links in the thread, saved under `refs/`.");
  lines.push("");
  for (const r of [...refs].sort((a, b) => Number(a.provenance === "reply") - Number(b.provenance === "reply"))) {
    lines.push(`\n*${r.provenance === "discovered" ? "Supplemental discovered source" : r.provenance === "reply" ? "Supplemental reply source" : "Author / quoted source"} · ${r.status ?? (r.error ? "failed" : "legacy status unknown")}*`);
    if (r.warning && !(r.kind === "video" && r.transcript?.status === "complete")) lines.push(`> ${r.warning}`);
    if (r.finalUrl && r.finalUrl !== r.url) lines.push(`Resolved URL: <${r.finalUrl}>`);
    if (r.canonicalUrl) lines.push(`Canonical URL: <${r.canonicalUrl}>`);
    if (r.kind === "video") {
      lines.push(`- **${r.title}** (video) — [original](${r.url})`);
      lines.push(transcriptBlock(r.transcript, r.files[0]));
      if (r.error && r.transcript?.status !== "complete") lines.push(`> ${r.error}`);
      continue;
    }
    if (r.media?.length) {
      const images = r.media.filter((media) => media.type === "photo");
      const downloaded = images.filter((media) => !!media.localPath).length;
      const analyzed = images.filter((media) => isValidEnrichment(media.enrichment)).length;
      lines.push(`Article images: ${downloaded}/${images.length} saved · ${analyzed}/${images.length} with OCR/analysis. See the saved article for images and inline text renderings.`);
      for (const image of images.filter((media) => !media.localPath || media.downloadError || media.enrichmentError)) {
        lines.push(`> Article image <${image.url}>: ${image.downloadError ?? image.enrichmentError ?? "image bytes not captured"}`);
      }
    }
    for (const video of r.videos ?? []) {
      lines.push(`Embedded video: <${video.url}>`, transcriptBlock(video.transcript, video.file));
    }
    if (r.files.length === 0) {
      lines.push(`- **${r.title}** (${r.kind}) — [original](${r.url}) — *${r.error ?? "fetch failed"}*`);
      continue;
    }
    if (r.files.length === 1) {
      const f = r.files[0];
      const meta = [fmtBytes(f.bytes), f.truncated ? "truncated" : ""].filter(Boolean).join(", ");
      lines.push(
        `- **${r.title}** (${r.kind}) — [original](${r.url}) · [saved copy](${f.localPath})${meta ? ` (${meta})` : ""}`,
      );
    } else {
      lines.push(`- **${r.title}** (${r.kind}) — [original](${r.url})`);
      for (const f of r.files) {
        const meta = [fmtBytes(f.bytes), f.truncated ? "truncated" : ""].filter(Boolean).join(", ");
        lines.push(`  - [${path.basename(f.localPath)}](${f.localPath})${meta ? ` (${meta})` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

function renderClaudeGuide(thread: Thread, slug: string): string {
  return `# Captured tweet thread — for analysis

This folder is a self-contained capture of an X/Twitter conversation produced by \`tweetmd\`.
You are likely being pointed here to read and analyze it.

## Files
- \`tweet.md\` — the author's own content: their preceding self-thread, the main
  tweet (with image analysis and any quoted tweet), and linked sources. Starts
  with a YAML frontmatter block (id, author, dates, metrics) so you can read
  metadata without parsing JSON. **Read this for the tweet itself** — it
  deliberately excludes the reply conversation to stay a focused payload.
- \`conversation.md\` — the reply conversation (other people's replies), split
  out of \`tweet.md\`. Present only when the capture has replies. Read it when
  you need the discussion, not just the author's statement.
- \`thread.json\` — the same content as structured data (authors, metrics, timestamps, media).
- \`media/\` — downloaded images and video poster frames referenced by the tweets.
- Saved caption Markdown (linked beside each video) records caption language, origin,
  timestamps and any truncation; a poster image alone is not a video transcript.
- \`refs/\` — content fetched from links in the thread (GitHub files, repo
  READMEs, gists, npm/PyPI packages, and readable web pages), saved as text.
  ${thread.references?.some((r) => r.files.length > 0) ? "See the **Linked sources** section in `tweet.md`." : "(none in this capture)"} These are often the real payload to read.

## What the data contains
- **Main tweet**: ${thread.main.author.name} (@${thread.main.author.handle}) — ${thread.sourceUrl}
- **Thread context**: ${thread.ancestors.length} preceding tweet(s).
- **Conversation**: ${thread.replies.length} reply tweet(s).
- **Quote tweets**: a tweet that quotes another carries the quoted tweet under
  \`quoted\` (rendered as a nested blockquote in \`tweet.md\`).
- **Article-embedded tweets**: an X Article can embed another tweet inline in
  its body, carried under \`embeddedTweets\` (rendered as a nested blockquote at
  its real position in \`tweet.md\`).
- Each image carries AI-derived fields where available: \`kind\` (flowchart /
  table / text / diagram / decorative), \`description\` (short alt-text), and
  \`content\` — a ready-to-read Markdown rendering of the image (a Mermaid diagram
  for flowcharts, a Markdown table for tables, a faithful transcription for
  text/slides/charts). These let you reason about image content without vision.
- **Image placement**: in an Article, each image's analysis is rendered inline
  in \`tweet.md\` at the image's real position in the body. For a short tweet,
  the analysis is listed after the tweet's text. \`thread.json\` always carries
  the full per-image \`enrichment\` regardless of placement.
- **Decorative images are dropped**: images the analysis judged purely
  decorative are not downloaded into \`media/\` and not embedded — only their
  short description is kept. Images with real content (screenshots, tables,
  diagrams, charts) are kept as files and embedded alongside their text rendering.

## Suggested entry points
- For the tweet itself (prose/quoting): read \`tweet.md\`.
- For the reply discussion: read \`conversation.md\` (if present).
- For programmatic analysis (counts, sentiment, extracting claims): parse \`thread.json\`.

Capture slug: \`${slug}\`
`;
}

export interface WriteResult {
  outDir: string;
  markdownPath: string;
  jsonPath: string;
}

/** Deterministic output folder for a thread: `<baseDir>/<handle>_<id>`. */
export function bundleDir(thread: Thread, baseDir: string): string {
  return path.join(baseDir, bundleSlug(thread));
}

/**
 * Folder name `<handle>_<id>`, with both fields sanitized. handle/id come from
 * parsed (untrusted) tweet JSON and feed a recursive fs.rm of the bundle's
 * media/ and refs/ subdirs, so strip anything that could traverse out of the
 * base dir (`/`, `..`) before joining.
 */
export function bundleSlug(thread: Thread): string {
  const clean = (s: string) => (s || "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "x";
  return `${clean(thread.main.author.handle)}_${clean(thread.main.id)}`;
}

/**
 * Write the three rendered docs (tweet.md, conversation.md, CLAUDE.md) for a
 * thread into `dir`. Shared by a fresh capture and by `reindexBundle`. Removes
 * a stale conversation.md when a thread has no replies. Does NOT write
 * thread.json or touch media/refs — the caller owns those.
 */
async function writeDocs(thread: Thread, dir: string, slug: string): Promise<string> {
  const markdownPath = path.join(dir, "tweet.md");
  await fs.writeFile(markdownPath, renderTweetDoc(thread), "utf8");

  const conversation = renderConversationDoc(thread);
  const conversationPath = path.join(dir, "conversation.md");
  if (conversation) await fs.writeFile(conversationPath, conversation, "utf8");
  else await fs.rm(conversationPath, { force: true }).catch(() => {});

  await fs.writeFile(path.join(dir, "CLAUDE.md"), renderClaudeGuide(thread, slug), "utf8");
  return markdownPath;
}

/** Write the full bundle to `<baseDir>/<handle>_<id>`. */
export async function writeBundle(thread: Thread, baseDir: string): Promise<WriteResult> {
  const slug = bundleSlug(thread);
  const outDir = bundleDir(thread, baseDir);
  await fs.mkdir(outDir, { recursive: true });

  const jsonPath = path.join(outDir, "thread.json");
  const markdownPath = await writeDocs(thread, outDir, slug);
  const tempPath = `${jsonPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(thread, null, 2), "utf8");
  await fs.rename(tempPath, jsonPath);
  if (thread.capture) {
    const coveragePath = path.join(outDir, "capture.json");
    const tempCoverage = `${coveragePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tempCoverage, JSON.stringify(thread.capture, null, 2) + "\n", "utf8");
    await fs.rename(tempCoverage, coveragePath);
  }

  return { outDir, markdownPath, jsonPath };
}

/**
 * Re-render the docs (tweet.md, conversation.md, CLAUDE.md) for one already-
 * captured bundle from its thread.json, without re-scraping, re-downloading
 * media, or re-enriching. Used to retrofit existing bundles to the current
 * format (e.g. the tweet.md / conversation.md split). Returns true on success,
 * false if the directory has no readable thread.json.
 */
export async function reindexBundle(dir: string): Promise<boolean> {
  let thread: Thread;
  try {
    thread = JSON.parse(await fs.readFile(path.join(dir, "thread.json"), "utf8")) as Thread;
  } catch {
    return false;
  }
  await writeDocs(thread, dir, bundleSlug(thread));
  return true;
}

/**
 * Re-render every bundle under `baseDir` from its thread.json. Used to retrofit
 * previously-captured bundles to the current doc format. Returns how many were
 * updated and how many directories were skipped (no readable thread.json).
 */
export async function reindexAll(baseDir: string): Promise<{ updated: number; skipped: number }> {
  let names: string[];
  try {
    names = (await fs.readdir(baseDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { updated: 0, skipped: 0 };
  }
  let updated = 0;
  let skipped = 0;
  for (const name of names) {
    if (await reindexBundle(path.join(baseDir, name))) updated++;
    else skipped++;
  }
  return { updated, skipped };
}

/** True if a photo has a local file but no enrichment result at all — the gap
 * left by a run where `enrichImages` failed or was skipped for the whole
 * capture (e.g. `claude` unavailable, `--no-enrich`), as opposed to the
 * decorative-image case where a `description` is kept and the file removed. */
function hasMissingEnrichment(thread: Thread, opts: EnrichOptions = {}): boolean {
  return allTweets(thread).some((t) =>
    t.media.some((m) => m.localPath && m.type === "photo" && !isValidEnrichment(m.enrichment)),
  );
}

/**
 * Re-run image enrichment for one already-captured bundle, then re-render its
 * docs. Reuses the media files already on disk — no re-scraping or
 * re-downloading. `enrichImages` itself skips cache hits (near-instant) and
 * only makes real `claude -p` calls for images that are missing or failed
 * before, so this is safe to run across a whole library repeatedly. Returns
 * null if the bundle had nothing missing (skipped entirely, no `claude -p`
 * calls), or a summary if it ran.
 */
export async function backfillBundleEnrichment(
  dir: string,
  opts: EnrichOptions = {},
  getProvider?: () => Promise<ProviderStatus>,
): Promise<{ analyzed: number; failed: number } | null> {
  const readThread = async (): Promise<Thread | null> => {
    try { return JSON.parse(await fs.readFile(path.join(dir, "thread.json"), "utf8")) as Thread; }
    catch { return null; }
  };
  const initial = await readThread();
  if (!initial || !hasMissingEnrichment(initial, opts)) return null;
  if (!/^\d+$/.test(initial.main.id)) throw new Error("Cannot acquire a capture lease for an invalid status ID.");
  const release = await acquireLease(path.join(path.dirname(dir), ".locks", `${initial.main.id}.lock`));
  try {
    // Another writer may have finished while we waited. Never write the pre-lease snapshot.
    const thread = await readThread();
    if (!thread || !hasMissingEnrichment(thread, opts)) return null;
    if (thread.main.id !== initial.main.id) throw new Error("Bundle identity changed while waiting for its writer lease.");
    const provider = opts.provider ?? (getProvider ? await getProvider() : undefined);
    const summary = await enrichImages(thread, dir, { ...opts, provider, resume: true });
    await pruneDecorativeMedia(thread, dir);
    thread.capture ??= newCaptureReport(thread);
    const targets = allTweets(thread).flatMap((tweet) => tweet.media).filter((media) => media.type === "photo" || opts.enrichPosters);
    const missing = targets.filter((media) => !isValidEnrichment(media.enrichment) && !media.enrichmentSkipped?.startsWith("Icon-sized"));
    setStage(thread, "ocr", { status: missing.length ? "partial" : "complete", completed: targets.length - missing.length,
      total: targets.length, message: summary.providerError ?? (missing.length ? "Some images lack OCR/analysis; see per-media errors." : undefined) });
    finalizeCapture(thread);
    // Preserve the requested existing directory, including legacy bundle names.
    for (const [name, value] of [["thread.json", thread], ["capture.json", thread.capture]] as const) {
      const target = path.join(dir, name);
      const temp = `${target}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
      await fs.rename(temp, target);
    }
    await writeDocs(thread, dir, bundleSlug(thread));
    return summary;
  } finally { await release(); }
}

/**
 * Backfill missing image enrichment across every bundle under `baseDir`.
 * Bundles with nothing missing are left untouched (no `claude -p` calls, no
 * rewritten files).
 */
export async function backfillEnrichmentAll(
  baseDir: string,
  opts: EnrichOptions = {},
): Promise<{ bundlesTouched: number; analyzed: number; failed: number }> {
  let names: string[];
  try {
    names = (await fs.readdir(baseDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { bundlesTouched: 0, analyzed: 0, failed: 0 };
  }
  let bundlesTouched = 0;
  let analyzed = 0;
  let failed = 0;
  let providerPromise: Promise<ProviderStatus> | undefined;
  const getProvider = () => providerPromise ??= opts.provider ? Promise.resolve(opts.provider) : preflightClaude(opts.claudeBin);
  for (const name of names) {
    const summary = await backfillBundleEnrichment(path.join(baseDir, name), opts, getProvider);
    if (summary) {
      bundlesTouched++;
      analyzed += summary.analyzed;
      failed += summary.failed;
    }
  }
  return { bundlesTouched, analyzed, failed };
}
