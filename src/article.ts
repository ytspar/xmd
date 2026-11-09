/**
 * Convert an X "Article" (long-form post) into Markdown.
 *
 * Article bodies are stored as a Draft.js `content_state` ({ blocks, entityMap })
 * rather than in `legacy.full_text`. We render the blocks to Markdown, inline
 * images at their real positions, and surface embedded code/config cards.
 */
import { decodeEntities } from "./entities.js";
import type { MediaItem, TweetNode } from "./types.js";

/** Mirror of media.ts naming so inline refs match the downloaded files. */
function extFromUrl(url: string, fallback = ".jpg"): string {
  const clean = url.split("?")[0];
  const dot = clean.lastIndexOf(".");
  const slash = clean.lastIndexOf("/");
  return dot > slash ? clean.slice(dot) : fallback;
}

interface DraftEntity {
  type: "MEDIA" | "LINK" | "MARKDOWN" | string;
  data: any;
}

/**
 * Wrap a segment in emphasis/link markers, keeping any leading/trailing
 * whitespace *outside* the markers — `*text *` is not valid Markdown emphasis,
 * so the whitespace must not sit between the marker and the word.
 */
function wrapSegment(seg: string, bold: boolean, italic: boolean, link: string | null): string {
  if (seg.trim() === "") return seg; // whitespace only — never style it
  const lead = seg.match(/^\s*/)![0];
  const trail = seg.match(/\s*$/)![0];
  let core = seg.slice(lead.length, seg.length - trail.length);
  if (italic) core = `*${core}*`;
  if (bold) core = `**${core}**`;
  if (link) core = `[${core}](${link})`;
  return lead + core + trail;
}

/**
 * Apply Bold/Italic/link runs over a block's text, segment by segment.
 * `ignoreStyles` drops bold/italic (used for headings, which are already
 * emphasized) while still resolving links.
 */
function renderInline(
  block: any,
  entityByKey: Map<number, DraftEntity>,
  ignoreStyles = false,
): string {
  // Draft.js offsets/lengths (from inlineStyleRanges/entityRanges) are in
  // UTF-16 code units, so split on those units too — Array.from iterates by
  // Unicode code point instead, which collapses a surrogate-pair character
  // (e.g. most emoji) into one element and shifts every later range by one.
  const chars = ((block.text as string) ?? "").split("");
  const n = chars.length;
  if (n === 0) return "";

  const bold = new Array<boolean>(n).fill(false);
  const italic = new Array<boolean>(n).fill(false);
  const link = new Array<string | null>(n).fill(null);

  if (!ignoreStyles) {
    for (const r of block.inlineStyleRanges ?? []) {
      for (let i = r.offset; i < r.offset + r.length && i < n; i++) {
        if (r.style === "Bold") bold[i] = true;
        else if (r.style === "Italic") italic[i] = true;
      }
    }
  }
  for (const r of block.entityRanges ?? []) {
    const ent = entityByKey.get(Number(r.key));
    if (ent?.type === "LINK" && ent.data?.url) {
      for (let i = r.offset; i < r.offset + r.length && i < n; i++) link[i] = ent.data.url;
    }
  }

  let out = "";
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && bold[j] === bold[i] && italic[j] === italic[i] && link[j] === link[i]) j++;
    out += wrapSegment(decodeEntities(chars.slice(i, j).join("")), bold[i], italic[i], link[i]);
    i = j;
  }
  return out;
}

interface RenderedBlock {
  md: string;
  isListItem: boolean;
}

function renderBlock(
  block: any,
  entityByKey: Map<number, DraftEntity>,
  localRefByMediaId: Map<string, string>,
): RenderedBlock {
  const type = block.type as string;
  const indent = "  ".repeat(block.depth ?? 0);

  if (type === "atomic") {
    const er = (block.entityRanges ?? [])[0];
    const ent = er ? entityByKey.get(Number(er.key)) : undefined;
    if (ent?.type === "DIVIDER") return { md: "---", isListItem: false };
    if (ent?.type === "MEDIA") {
      const items = ent.data?.mediaItems?.length ? ent.data.mediaItems : [{ mediaId: "unknown" }];
      const md = items.map((item: { mediaId?: string }) => {
        const mediaId = String(item.mediaId ?? "unknown");
        const ref = localRefByMediaId.get(mediaId);
        return ref ? `![article image](${ref})` : `[Original image: ${mediaId}]`;
      }).join("\n\n");
      return { md, isListItem: false };
    }
    if (ent?.type === "MARKDOWN") {
      return { md: (ent.data?.markdown as string) || "[Unsupported article entity: empty MARKDOWN]", isListItem: false };
    }
    if (ent?.type === "TWEET") {
      const tweetId = ent.data?.tweetId;
      return { md: tweetId ? `[[embedded-tweet:${tweetId}]]` : "[Unsupported article entity: TWEET without ID]", isListItem: false };
    }
    return { md: `[Unsupported article entity: ${ent?.type ?? "unknown"}]`, isListItem: false };
  }

  const isHeading = type === "header-one" || type === "header-two" || type === "header-three";
  const inline = renderInline(block, entityByKey, isHeading);
  // X's article editor uses an empty heading block as a visual spacer; a bare
  // "#"/"##"/"###" line would just leak that spacer into the Markdown.
  if (isHeading && inline.trim() === "") return { md: "", isListItem: false };
  switch (type) {
    case "header-one":
      return { md: `# ${inline}`, isListItem: false };
    case "header-two":
      return { md: `## ${inline}`, isListItem: false };
    case "header-three":
      return { md: `### ${inline}`, isListItem: false };
    case "blockquote":
      return { md: `> ${inline}`, isListItem: false };
    case "code-block":
      return { md: "```\n" + (block.text ?? "") + "\n```", isListItem: false };
    case "ordered-list-item":
      return { md: `${indent}1. ${inline}`, isListItem: true };
    case "unordered-list-item":
      return { md: `${indent}- ${inline}`, isListItem: true };
    default:
      return { md: inline, isListItem: false };
  }
}

export interface ParsedArticle {
  markdown: string;
  media: MediaItem[];
  /** Tweets embedded inline in the article that we were able to resolve. */
  embeds: TweetNode[];
}

/**
 * Render `article_results.result` to Markdown and collect its images.
 * `tweetId` is used to compute deterministic media filenames that match
 * what media.ts will download (`<tweetId>-<index>.<ext>`). `embeddedTweets`
 * resolves any `TWEET` entities the article's body references (see
 * `x-parse.ts`'s `parseTweetResultsByRestIds`); markers for entities that
 * don't resolve (e.g. deleted source tweet) are left as a plain link at
 * render time.
 */
export function parseArticle(
  ar: any,
  tweetId: string,
  embeddedTweets?: Map<string, TweetNode>,
): ParsedArticle {
  const cs = ar?.content_state;
  if (!Array.isArray(cs?.blocks)) return { markdown: "", media: [], embeds: [] };

  // entityMap is an array of { key, value } — index by numeric key.
  const entityByKey = new Map<number, DraftEntity>();
  const entities = Array.isArray(cs.entityMap) ? cs.entityMap : Object.entries(cs.entityMap ?? {}).map(([key, value]) => ({ key, value }));
  for (const entry of entities) {
    if (entry?.key != null && entry.value) entityByKey.set(Number(entry.key), entry.value);
  }

  // Register every article image as downloadable media, in stable order, and
  // remember the local path each mediaId will resolve to. A GIF/video entry
  // has no `original_img_url` of its own — its still frame lives at
  // `media_info.preview_image.original_img_url` instead.
  const media: MediaItem[] = [];
  const localRefByMediaId = new Map<string, string>();
  (ar.media_entities ?? []).forEach((me: any, idx: number) => {
    const rawUrl: string | undefined =
      me?.media_info?.original_img_url ?? me?.media_info?.preview_image?.original_img_url ?? me?.url;
    if (!rawUrl) return;
    let url: string;
    try {
      const parsedUrl = new URL(rawUrl);
      if (!/^https?:$/.test(parsedUrl.protocol)) return;
      parsedUrl.searchParams.set("name", "orig");
      url = parsedUrl.toString();
    } catch { return; }
    const localPath = `media/${tweetId}-${idx}${extFromUrl(rawUrl)}`;
    // `articleIndex` is this entry's position in `ar.media_entities` — a rawUrl-less
    // entry (rare) is skipped above, so `media`'s array position can drift from
    // that original index. articleBodyWithMedia matches on `articleIndex`, not
    // array position, so body placeholders (which embed the original index in
    // their path) always land on the right image even when entries were skipped.
    media.push({ url, type: "photo", inline: true, articleIndex: idx });
    if (me.media_id) localRefByMediaId.set(String(me.media_id), localPath);
  });

  const rendered = cs.blocks
    .map((b: any) => renderBlock(b, entityByKey, localRefByMediaId))
    .filter((r: RenderedBlock) => r.md !== "");

  let body = "";
  rendered.forEach((r: RenderedBlock, i: number) => {
    if (i === 0) {
      body = r.md;
      return;
    }
    const prev = rendered[i - 1];
    const sep = r.isListItem && prev.isListItem ? "\n" : "\n\n";
    body += sep + r.md;
  });

  const title = ar.title ? `# ${decodeEntities(ar.title)}\n\n` : "";

  const embeds: TweetNode[] = [];
  for (const ent of entityByKey.values()) {
    if (ent.type !== "TWEET" || !ent.data?.tweetId) continue;
    const embedded = embeddedTweets?.get(String(ent.data.tweetId));
    if (embedded) embeds.push(embedded);
  }

  return { markdown: title + body, media, embeds };
}

/** Upgrade lossless markers emitted before a known entity had a renderer. */
export function normalizeLegacyArticleMarkers(text: string): string {
  return text.replace(/^\[Unsupported article entity: DIVIDER\]$/gm, "---");
}
