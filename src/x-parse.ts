/**
 * Parse X's `TweetDetail` GraphQL responses into structured tweet nodes.
 *
 * We intercept the JSON the page already fetches rather than scraping the DOM:
 * it is far more stable and gives us clean metrics, timestamps and media.
 * X reshapes these payloads periodically, so every access is defensive.
 */
import { parseArticle } from "./article.js";
import { decodeEntities } from "./entities.js";
import type { MediaItem, Thread, TweetMetrics, TweetNode } from "./types.js";

function num(v: unknown): number {
  const n = typeof v === "string" ? parseInt(v, 10) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

/** Unwrap visibility wrappers so we always work with the underlying Tweet. */
function unwrapTweet(result: any): any | null {
  if (!result || typeof result !== "object") return null;
  if (result.__typename === "TweetWithVisibilityResults" && result.tweet) {
    return result.tweet;
  }
  if (result.tweet && !result.legacy) return result.tweet;
  return result;
}

function expandText(t: any, noteText?: string): string {
  const legacy = t?.legacy ?? {};
  let text: string = noteText ?? legacy.full_text ?? legacy.text ?? "";
  // note_tweet (the long-tweet payload) lives on the tweet result itself, not
  // inside `legacy` — its entity_set is where a long tweet's t.co links expand from.
  const urls = noteText
    ? t?.note_tweet?.note_tweet_results?.result?.entity_set?.urls ?? []
    : legacy.entities?.urls ?? [];
  for (const u of urls) {
    if (u?.url && u?.expanded_url) text = text.split(u.url).join(u.expanded_url);
  }
  // Drop the trailing t.co link X appends for attached media.
  const media = legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
  for (const m of media) {
    if (m?.url) text = text.split(m.url).join("");
  }
  return decodeEntities(text).trim();
}

function parseMedia(legacy: any): MediaItem[] {
  const media = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
  const out: MediaItem[] = [];
  for (const m of media) {
    const base: string | undefined = m?.media_url_https;
    if (!base) continue;
    const type = (m?.type ?? "photo") as MediaItem["type"];
    // Request the largest still: ?name=orig for photos.
    const url = type === "photo" ? `${base}?name=orig` : base;
    out.push({
      url,
      type,
      altText: m?.ext_alt_text ?? undefined,
      videoUrl: type === "video" ? [...(m?.video_info?.variants ?? [])].filter((variant: any) => variant.content_type === "video/mp4").sort((a: any, b: any) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]?.url : undefined,
      captionTracks: (m?.video_info?.caption_tracks ?? m?.caption_tracks ?? []).map((track: any) => ({ url: track.url ?? track.base_url, language: track.language ?? track.language_code, automatic: track.automatic })).filter((track: any) => typeof track.url === "string"),
    });
  }
  return out;
}

function metricsOf(t: any): TweetMetrics {
  const legacy = t.legacy ?? {};
  return {
    likes: num(legacy.favorite_count),
    retweets: num(legacy.retweet_count),
    replies: num(legacy.reply_count),
    quotes: num(legacy.quote_count),
    bookmarks: num(legacy.bookmark_count),
    views: t.views?.count ? num(t.views.count) : undefined,
  };
}

function toIso(raw: string): string | undefined {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Convert a `tweet_results.result` object into a TweetNode (or null). */
export function parseTweetResult(
  result: any,
  depth = 0,
  embeddedTweets?: Map<string, TweetNode>,
): TweetNode | null {
  const t = unwrapTweet(result);
  if (!t || !t.legacy) return null;

  const userResult = t.core?.user_results?.result ?? {};
  const userCore = userResult.core ?? {};
  const userLegacy = userResult.legacy ?? {};
  const handle: string = userCore.screen_name ?? userLegacy.screen_name ?? "unknown";
  const name: string = userCore.name ?? userLegacy.name ?? handle;

  const noteText: string | undefined = t.note_tweet?.note_tweet_results?.result?.text;
  const id: string = t.rest_id ?? t.legacy.id_str ?? "";
  const createdAtRaw: string = t.legacy.created_at ?? "";

  // X "Articles" keep the body in a Draft.js content_state, not full_text.
  const articleResult = t.article?.article_results?.result;
  let text = expandText(t, noteText);
  let media = parseMedia(t.legacy);
  let isArticle = !!articleResult;
  const articleIssues: string[] = [];
  let embeddedTweetNodes: TweetNode[] | undefined;
  if (articleResult) {
    const article = parseArticle(articleResult, id, embeddedTweets);
    if (!article.markdown) articleIssues.push("Article body was not served by X.");
    if (article.markdown) {
      text = article.markdown;
      isArticle = true;
    }
    media = [...article.media, ...media];
    if (article.embeds.length) embeddedTweetNodes = article.embeds;
  }

  const node: TweetNode = {
    id,
    url: `https://x.com/${handle}/status/${id}`,
    author: { name, handle },
    text,
    createdAtRaw,
    createdAt: createdAtRaw ? toIso(createdAtRaw) : undefined,
    metrics: metricsOf(t),
    media,
    isMainTweet: false,
    isArticle,
    articleIssues: articleIssues.length ? articleIssues : undefined,
    embeddedTweets: embeddedTweetNodes,
  };

  // Quote tweets embed the quoted tweet at `quoted_status_result.result`.
  // Parse one level deep (a quoted tweet may itself quote, but we stop there).
  const quotedResult = t.quoted_status_result?.result;
  if (quotedResult && depth < 1) {
    const quoted = parseTweetResult(quotedResult, depth + 1, embeddedTweets);
    if (quoted) node.quoted = quoted;
  }

  return node;
}

/**
 * Every tweet in the thread, including nested quoted and article-embedded
 * tweets, deduped by id. A quoted/embedded tweet can repeat a tweet already
 * present elsewhere (e.g. a reply quotes the main tweet); without dedup that
 * id's media would be downloaded and enriched twice and could end up with a
 * dangling embed.
 */
export function allTweets(thread: Thread): TweetNode[] {
  const out: TweetNode[] = [];
  const seen = new Set<string>();
  const visit = (n: TweetNode) => {
    if (seen.has(n.id)) return;
    if (n.id) {
      seen.add(n.id);
      out.push(n);
    }
    if (n.quoted) visit(n.quoted);
    for (const e of n.embeddedTweets ?? []) visit(e);
  };
  for (const n of [thread.main, ...thread.ancestors, ...thread.replies]) visit(n);
  for (const link of thread.linkedTweets ?? []) {
    if (link.thread) for (const n of allTweets(link.thread)) visit(n);
  }
  return out;
}

export interface ParsedEntries {
  /** Top-level tweets in display order (ancestors + focal tweet). */
  topLevel: TweetNode[];
  /** Reply tweets pulled from conversation-thread modules, in order. */
  replies: TweetNode[];
}

/** Walk one or more TweetDetail payloads and collect ordered tweet nodes. */
export function parseTweetDetail(
  payloads: any[],
  embeddedTweets?: Map<string, TweetNode>,
): ParsedEntries {
  const topLevel: TweetNode[] = [];
  const replies: TweetNode[] = [];
  const seen = new Set<string>();

  const pushUnique = (arr: TweetNode[], node: TweetNode | null) => {
    if (!node || !node.id || seen.has(node.id)) return;
    seen.add(node.id);
    arr.push(node);
  };

  for (const payload of payloads) {
    const instructions =
      payload?.data?.threaded_conversation_with_injections_v2?.instructions ?? [];
    for (const instr of instructions) {
      if (instr?.type !== "TimelineAddEntries") continue;
      for (const entry of instr.entries ?? []) {
        const id: string = entry?.entryId ?? "";
        const content = entry?.content;
        if (id.startsWith("tweet-")) {
          pushUnique(
            topLevel,
            parseTweetResult(content?.itemContent?.tweet_results?.result, 0, embeddedTweets),
          );
        } else if (id.startsWith("conversationthread-")) {
          for (const item of content?.items ?? []) {
            // Ads X injects into the reply thread: entryId carries a
            // "-promoted-tweet-" segment and itemContent.promotedMetadata is
            // set. Neither is a real reply, so skip both.
            const itemContent = item?.item?.itemContent;
            if (itemContent?.promotedMetadata || String(item?.entryId ?? "").includes("-promoted-tweet-")) {
              continue;
            }
            pushUnique(replies, parseTweetResult(itemContent?.tweet_results?.result, 0, embeddedTweets));
          }
        }
      }
    }
  }

  return { topLevel, replies };
}

/**
 * Resolve the tweets an X Article embeds inline. Unlike a quote tweet, an
 * embedded article tweet's content never arrives with the article payload —
 * the page fetches it separately via a `TweetResultsByRestIds` call, keyed by
 * the tweet ids the article references (see `article.ts`'s `TWEET` entities).
 *
 * An embedded tweet can itself be an Article that embeds a further tweet (a
 * "sub-article"), so this resolves in two passes: first parse every fetched
 * tweet on its own (its own embeds still unresolved), then re-run each
 * article's embed resolution against the now-complete map. Node objects are
 * shared by reference, so patching a leaf's `embeddedTweets` in the second
 * pass is visible to any node above it that already embeds that leaf —
 * nesting depth doesn't matter, order of arrival doesn't matter.
 */
export function parseTweetResultsByRestIds(payloads: any[]): Map<string, TweetNode> {
  const out = new Map<string, TweetNode>();
  const articleRaw: { id: string; result: any }[] = [];
  for (const payload of payloads) {
    for (const item of payload?.data?.tweetResult ?? []) {
      const node = parseTweetResult(item?.result);
      if (!node) continue;
      out.set(node.id, node);
      // A fetched tweet's own quote (parsed one level deep by parseTweetResult)
      // is real data we already have — register it under its own id too, so a
      // TWEET entity elsewhere that references *that* tweet (never
      // independently fetched via TweetResultsByRestIds) still resolves
      // instead of falling back to a bare link.
      if (node.quoted) out.set(node.quoted.id, node.quoted);
      const articleResult = unwrapTweet(item?.result)?.article?.article_results?.result;
      if (articleResult) articleRaw.push({ id: node.id, result: articleResult });
    }
  }
  for (const { id, result } of articleRaw) {
    const article = parseArticle(result, id, out);
    if (article.embeds.length) out.get(id)!.embeddedTweets = article.embeds;
  }
  return out;
}

/** Extract the status id from any x.com / twitter.com tweet URL. */
export function statusIdFromUrl(url: string): string | null {
  const m = url.match(/status(?:es)?\/(\d+)/);
  return m ? m[1] : null;
}
