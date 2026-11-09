#!/usr/bin/env tsx
/**
 * Manual audit/regeneration of `<out>/categories.md` from `<out>/categories.json`.
 * Categorization itself now happens automatically during capture (see
 * `src/categorize.ts`, wired into `src/pipeline.ts`) — this script exists for
 * re-rendering the index after a hand-edit of categories.json, or auditing
 * for uncategorized/stale entries across the whole out dir.
 *
 * Usage: tsx scripts/categorize.ts [--out <dir>]
 */
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { moveCategoryToCollection, regenerateCategoriesMd, setCategory, setCollections, setTags } from "../src/categorize.js";
import { resolveBundle } from "../src/read.js";
import type { Thread } from "../src/types.js";

interface Args { out?: string; bundle?: string; category?: string; collections?: string[]; tags?: string[]; move?: string }
function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--out", "--bundle", "--category", "--collections", "--tags", "--move-to-collection"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--out") args.out = value;
    if (flag === "--bundle") args.bundle = value;
    if (flag === "--category") args.category = value;
    if (flag === "--collections") args.collections = value.split(",").map((part) => part.trim()).filter(Boolean);
    if (flag === "--tags") args.tags = value.split(",").map((part) => part.trim()).filter(Boolean);
    if (flag === "--move-to-collection") args.move = value;
  }
  if ((args.category !== undefined || args.collections !== undefined || args.tags !== undefined) && !args.bundle) throw new Error("Specify --bundle when setting a category, collections or tags.");
  return args;
}

function outBase(cliOut?: string): string {
  if (cliOut) return path.resolve(cliOut);
  if (process.env.TWEETMD_OUT) return path.resolve(process.env.TWEETMD_OUT);
  return path.join(os.homedir(), ".tweetmd", "out");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base = outBase(args.out);
  if (args.move) await moveCategoryToCollection(base, args.move);
  if (args.bundle) {
    const dir = await resolveBundle(base, args.bundle);
    if (!dir) throw new Error(`No bundle matching ${args.bundle}`);
    const thread = JSON.parse(await fs.readFile(path.join(dir, "thread.json"), "utf8")) as Thread;
    if (args.category !== undefined) await setCategory(thread, base, args.category);
    if (args.collections !== undefined) await setCollections(thread, base, args.collections);
    if (args.tags !== undefined) await setTags(thread, base, args.tags);
  }
  const result = await regenerateCategoriesMd(base);
  console.log(result.path);
  if (result.uncategorized.length) console.log(`${result.uncategorized.length} uncategorized: ${result.uncategorized.join(", ")}`);
  if (result.stale.length) console.log(`${result.stale.length} stale: ${result.stale.join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
