/**
 * Builds a copy/paste instruction for another agent session, pointing it at
 * a set of captures to mine for ideas. References can be a category id
 * (`reading-list`, `agents-and-coding/context-and-memory`), a tweet URL, a bundle
 * slug/handle, a bundle dir, or a directory of bundles — mixed freely.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { loadManifest } from "./categorize.js";
import { resolveBundle } from "./read.js";
import type { Thread } from "./types.js";

const INSTRUCTION =
  "Review the tweets here for relevant information, compare it against what we have already built and apply valid concepts:";

async function isBundle(dir: string): Promise<boolean> {
  return fs.access(path.join(dir, "thread.json")).then(
    () => true,
    () => false,
  );
}

/** Top-level bundle dirs directly under `dir` (not recursive, skips archive/). */
async function bundlesIn(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory() && e.name !== "archive").map((e) => path.join(dir, e.name));
  const flags = await Promise.all(dirs.map(isBundle));
  return dirs.filter((_, i) => flags[i]).sort();
}

/** Resolve one reference to zero or more bundle dirs. */
async function resolveRef(outBase: string, ref: string): Promise<string[]> {
  // Category, optionally with a subcategory.
  const manifest = await loadManifest(outBase);
  const [cat, sub] = ref.split("/", 2);
  // Explicit prefixes avoid ambiguity between topic and collection names.
  if (cat === "collection" || cat === "tag") {
    const slugs = manifest.items
      .filter((item) => (cat === "collection" ? item.collections : item.tags)?.includes(sub))
      .map((item) => path.join(outBase, item.slug));
    const flags = await Promise.all(slugs.map(isBundle));
    return slugs.filter((_, index) => flags[index]);
  }
  if ((manifest.collections ?? []).some((collection) => collection.id === ref)
    && !manifest.categories.some((category) => category.id === ref)) {
    const slugs = manifest.items.filter((item) => item.collections?.includes(ref)).map((item) => path.join(outBase, item.slug));
    const flags = await Promise.all(slugs.map(isBundle));
    return slugs.filter((_, index) => flags[index]);
  }

  if (manifest.categories.some((c) => c.id === cat)) {
    const slugs = manifest.items
      .filter((i) => i.category === cat && (!sub || i.subcategory === sub))
      .map((i) => path.join(outBase, i.slug));
    const flags = await Promise.all(slugs.map(isBundle));
    return slugs.filter((_, i) => flags[i]);
  }

  // Tweet URL → bundle whose slug ends with the status id.
  const status = ref.match(/status(?:es)?\/(\d+)/)?.[1];
  if (status) {
    const hit = (await bundlesIn(outBase)).find((d) => path.basename(d).endsWith(`_${status}`));
    return hit ? [hit] : [];
  }

  // A directory of bundles (e.g. the out dir itself), or a single bundle.
  const asPath = path.resolve(ref);
  if (!(await isBundle(asPath))) {
    const inside = await bundlesIn(asPath);
    if (inside.length) return inside;
  }
  const one = await resolveBundle(outBase, ref);
  return one ? [path.resolve(one)] : [];
}

async function describe(dir: string): Promise<string> {
  const tweetMd = path.join(dir, "tweet.md");
  try {
    const thread = JSON.parse(await fs.readFile(path.join(dir, "thread.json"), "utf8")) as Thread;
    return `- ${tweetMd} (@${thread.main.author.handle}, ${thread.main.url})`;
  } catch {
    return `- ${tweetMd}`;
  }
}

export interface AgentPrompt {
  text: string;
  count: number;
  notFound: string[];
}

export async function buildAgentPrompt(outBase: string, refs: string[]): Promise<AgentPrompt> {
  const dirs: string[] = [];
  const notFound: string[] = [];
  for (const ref of refs) {
    const found = await resolveRef(outBase, ref);
    if (!found.length) notFound.push(ref);
    for (const d of found) if (!dirs.includes(d)) dirs.push(d);
  }
  const lines = await Promise.all(dirs.map(describe));
  const text = [
    INSTRUCTION,
    "",
    ...lines,
    "",
    "Each tweet.md sits in a capture folder with a CLAUDE.md orientation file, thread.json, media/, and refs/ (fetched linked sources) — read those too.",
  ].join("\n");
  return { text, count: dirs.length, notFound };
}

/** Best-effort copy to the macOS clipboard; resolves false if pbcopy is unavailable. */
export function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
    p.stdin.on("error", () => {});
    p.stdin.end(text);
  });
}
