/** Follow only payload-bearing X references, with a fixed depth/count budget. */
import { tweetUrls } from "./input.js";
import { allTweets } from "./x-parse.js";
import type { Thread, TweetNode } from "./types.js";

export function needsArticleRefresh(node: TweetNode): boolean {
  return !!node.isArticle && (!!node.articleIssues?.length || /\[Original image:/.test(node.text) || !node.text.trim());
}

/** Retry unresolved article payloads while retaining valid, matching media analysis. */
export async function refreshIncompleteArticles(thread: Thread, scrape: (url: string) => Promise<Thread>, limit = 3): Promise<void> {
  let attempts = 0;
  const roots = [thread.main, ...thread.ancestors, ...thread.replies.filter((node) => node.author.handle.toLowerCase() === thread.main.author.handle.toLowerCase())];
  const nodes = allTweets({ ...thread, main: roots[0], ancestors: roots.slice(1), replies: [] });
  for (const node of nodes) {
    if (!needsArticleRefresh(node) || attempts++ >= limit) continue;
    try {
      const updated = await scrape(node.url);
      const replacement = updated.main;
      if (replacement.id !== node.id) throw new Error("Refreshed article ID did not match.");
      if (!replacement.isArticle || replacement.articleIssues?.some((issue) => /body.*not served/i.test(issue)) ||
        (node.text.length > 500 && replacement.text.length < node.text.length * 0.7)) {
        throw new Error("Refreshed response did not contain an equally complete Article body; retained saved article.");
      }
      for (const media of replacement.media) {
        const saved = node.media.find((prior) => prior.url === media.url && prior.articleIndex === media.articleIndex);
        if (saved) Object.assign(media, { localPath: saved.localPath, enrichment: saved.enrichment });
      }
      const isMainTweet = node.isMainTweet;
      delete node.articleIssues;
      Object.assign(node, replacement, { isMainTweet });
    } catch (error) {
      node.articleIssues = [...(node.articleIssues ?? []).filter((issue) => !issue.startsWith("Article retry failed:")), `Article retry failed: ${(error as Error).message}`];
    }
  }
}

export async function followLinkedTweets(
  thread: Thread,
  scrape: (url: string) => Promise<Thread>,
  opts: { resume?: boolean; limit?: number; onStatus?: (message: string) => void } = {},
): Promise<void> {
  const represented = new Set(allTweets({ ...thread, linkedTweets: undefined }).map((node) => node.id));
  const primary: TweetNode[] = [];
  const visit = (node: TweetNode) => {
    if (primary.some((tweet) => tweet.id === node.id)) return;
    primary.push(node);
    if (node.quoted) visit(node.quoted);
    for (const embedded of node.embeddedTweets ?? []) visit(embedded);
  };
  for (const node of [thread.main, ...thread.ancestors, ...thread.replies]) {
    if (node.author.handle.toLowerCase() === thread.main.author.handle.toLowerCase()) visit(node);
  }
  thread.linkedTweets ??= [];
  const requested = new Set<string>();
  let attempted = 0;
  const limit = Math.max(0, opts.limit ?? 3);
  for (const node of primary) {
    const urls = tweetUrls(node.text);
    // Explicit Article embeds whose side GraphQL response never arrived also need resolution.
    for (const match of node.text.matchAll(/\[\[embedded-tweet:(\d+)\]\]/g)) urls.push(`https://x.com/i/status/${match[1]}`);
    for (const url of urls) {
      const id = url.match(/status\/(\d+)/)![1];
      if (represented.has(id) || requested.has(id)) continue;
      requested.add(id);
      const index = thread.linkedTweets.findIndex((link) => link.url.endsWith(`/status/${id}`));
      const previous = thread.linkedTweets[index];
      if (opts.resume && previous?.status === "complete") continue;
      if (attempted++ >= limit) {
        const skipped = { url, sourceTweetId: node.id, status: "skipped" as const, error: `Linked X capture limit (${limit}) reached; depth is limited to one hop.` };
        if (index >= 0) thread.linkedTweets[index] = skipped; else thread.linkedTweets.push(skipped);
        continue;
      }
      opts.onStatus?.(`Following linked tweet ${url}…`);
      try {
        const linked = await scrape(url);
        linked.replies = linked.replies.filter((reply) => reply.author.handle.toLowerCase() === linked.main.author.handle.toLowerCase());
        const partial = needsArticleRefresh(linked.main);
        const result = { url, sourceTweetId: node.id, status: partial ? "partial" as const : "complete" as const, error: partial ? "Linked article body/assets were not fully served." : undefined, thread: linked };
        if (index >= 0) thread.linkedTweets[index] = result; else thread.linkedTweets.push(result);
        if (node.text.includes(`[[embedded-tweet:${id}]]`)) (node.embeddedTweets ??= []).push(linked.main);
      } catch (error) {
        const result = { url, sourceTweetId: node.id, status: "failed" as const, error: (error as Error).message };
        if (index >= 0) thread.linkedTweets[index] = result; else thread.linkedTweets.push(result);
      }
    }
  }
}
