#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs/promises";
import { runBatch } from "./batch.js";
import { tweetUrls } from "./input.js";
import path from "node:path";
import process from "node:process";
import React, { useEffect, useState } from "react";
import { Box, render, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { runPipeline, type PipelineOptions } from "./pipeline.js";
import { backfillEnrichmentAll, reindexAll } from "./render.js";
import { buildAgentPrompt, copyToClipboard } from "./prompt.js";
import { archiveBundles, runReader } from "./read.js";
import type { MermaidMode } from "./mermaid.js";
import { login } from "./scrape.js";

interface Args {
  command: "capture" | "batch" | "login" | "help" | "read" | "browse" | "reindex" | "archive" | "prompt";
  url?: string;
  resume: boolean;
  transcripts: boolean;
  inputFile?: string;
  refs: string[];
  headless: boolean;
  enrich: boolean;
  reenrich: boolean;
  plain: boolean;
  outBase: string;
  scrolls: number;
  model?: string;
  cheapModel?: string;
  tiered: boolean;
  enrichPosters: boolean;
  noCache: boolean;
  links: boolean;
  allLinks: boolean;
  categorize: boolean;
  category?: string;
  mermaid: MermaidMode;
}

/**
 * Where captures live. Pinned to ~/.tweetmd/out (alongside the profile and
 * enrich cache) so `xmd` works the same from any directory when installed
 * globally — not relative to the current working directory. Override with
 * TWEETMD_OUT or --out.
 */
function defaultOutBase(): string {
  const env = process.env.TWEETMD_OUT;
  return env ? path.resolve(env) : path.join(os.homedir(), ".tweetmd", "out");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "capture",
    resume: false,
    transcripts: true,
    refs: [],
    headless: true,
    reenrich: false,
    enrich: true,
    plain: false,
    outBase: defaultOutBase(),
    scrolls: 6,
    tiered: true,
    enrichPosters: false,
    noCache: false,
    links: true,
    allLinks: false,
    categorize: true,
    mermaid: "ascii",
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "batch") args.command = "batch";
    else if (a === "--no-transcripts") args.transcripts = false;
    else if (a === "--resume") args.resume = true;
    else if (a === "--file") args.inputFile = argv[++i];
    else if (a === "login") args.command = "login";
    else if (a === "read") args.command = "read";
    else if (a === "browse") args.command = "browse";
    else if (a === "reindex") args.command = "reindex";
    else if (a === "archive") args.command = "archive";
    else if (a === "prompt") args.command = "prompt";
    else if (a === "help" || a === "--help" || a === "-h") args.command = "help";
    else if (a === "--headed") args.headless = false;
    else if (a === "--headless") args.headless = true;
    else if (a === "--no-enrich") args.enrich = false;
    else if (a === "--reenrich") args.reenrich = true;
    else if (a === "--plain") args.plain = true;
    else if (a === "--out") args.outBase = path.resolve(argv[++i] ?? "out");
    else if (a === "--scrolls") args.scrolls = parseInt(argv[++i] ?? "6", 10) || 6;
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--cheap-model") args.cheapModel = argv[++i];
    else if (a === "--no-tiered") args.tiered = false;
    else if (a === "--enrich-posters") args.enrichPosters = true;
    else if (a === "--mermaid") {
      const v = argv[++i];
      if (v === "ascii" || v === "image" || v === "off") args.mermaid = v;
    }
    else if (a === "--no-cache") args.noCache = true;
    else if (a === "--no-links") args.links = false;
    else if (a === "--all-links") args.allLinks = true;
    else if (a === "--no-categorize") args.categorize = false;
    else if (a === "--category") args.category = argv[++i];
    else if (!a.startsWith("-")) rest.push(a);
  }
  if (!args.url && rest.length) args.url = tweetUrls(rest[0])[0] ?? rest[0];
  args.refs = rest;
  return args;
}

const HELP = `xmd — capture an X/Twitter tweet + conversation as Markdown

Usage:
  xmd <tweet-url> [options]
  xmd batch <URLs or pasted Markdown...> [--file <path>] [--resume]
  xmd browse                Browse captures in a menu, read with inline images
  xmd read [bundle]         Read a capture (a slug/handle, or omit to browse)
  xmd reindex               Re-render existing bundles to the current format
  xmd reindex --reenrich    Also backfill missing image enrichment (skipped/failed photos), then re-render
  xmd archive <bundle...>   Move captures (slug/handle) out of browse/reindex into archive/
  xmd prompt <ref...>       Print (and copy) an agent message to review captures; a ref is a
                                category[/sub], tweet URL, slug/handle, bundle dir, or dir of bundles
  xmd login                 Open a browser to sign in to X (run once)

Options:
  --no-transcripts Skip public video caption retrieval
  --resume         Reuse saved text and retry incomplete stages/assets
  --file <path>    Read batch URLs/Markdown from a UTF-8 file
  --headed         Show the browser window (default: headless)
  --no-enrich      Skip image OCR / mermaid / description (no claude -p)
  --model <id>     Strong model for structured images (default: claude-sonnet-4-6)
  --cheap-model <id> Cheap model for text/decorative + repair (default: claude-haiku-4-5)
  --no-tiered      Use the strong model for every image (no cheap-first cascade)
  --enrich-posters Also analyze video/GIF poster frames (default: skip them)
  --no-cache       Don't reuse cached image analysis (re-run claude -p)
  --no-links       Don't fetch GitHub/gist links found in the thread
  --all-links      Follow web links from every poster, not just the author
  --no-categorize  Skip topic categorization (no claude -p, categories.json unchanged)
  --category <id>[/<sub>] File under this category (created if new) instead of auto-categorizing
  --mermaid <mode> Reader diagram rendering: ascii (termaid, default) | image (mermaid.ink) | off
  --out <dir>      Output base directory (default: ~/.tweetmd/out, or $TWEETMD_OUT)
  --scrolls <n>    How many times to scroll for replies (default: 6)
  --plain          Plain log output instead of the TUI
  -h, --help       Show this help

Output: ~/.tweetmd/out/<handle>_<id>/ with tweet.md, conversation.md, thread.json, CLAUDE.md, media/`;

/** Ink TUI: shows a live status line + scrolling log, then the result. */
function App({ opts }: { opts: PipelineOptions }) {
  const { exit } = useApp();
  const [log, setLog] = useState<string[]>([]);
  const [current, setCurrent] = useState("Starting…");
  const [finished, setFinished] = useState<
    { ok: true; dir: string; md: string; partial: boolean } | { ok: false; error: string } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for await (const ev of runPipeline(opts)) {
        if (cancelled) return;
        if (ev.type === "status") {
          setCurrent(ev.message);
          setLog((l) => [...l.slice(-8), ev.message]);
        } else if (ev.type === "done") {
          const partial = ev.thread.capture?.status !== "complete";
          if (partial) process.exitCode = 2;
          setFinished({ ok: true, dir: ev.result.outDir, md: ev.result.markdownPath, partial });
        } else {
          setFinished({ ok: false, error: ev.error });
        }
      }
      if (!cancelled) {
        setTimeout(() => exit(), 50);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text>
        <Text color="cyan" bold>
          xmd
        </Text>{" "}
        <Text dimColor>{opts.url}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {log.map((line, i) => (
          <Text key={i} dimColor>
            {"  "}
            {line}
          </Text>
        ))}
      </Box>
      {!finished && (
        <Text>
          <Text color="green">
            <Spinner type="dots" />
          </Text>{" "}
          {current}
        </Text>
      )}
      {finished?.ok === true && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={finished.partial ? "yellow" : "green"}>{finished.partial ? "⚠ Saved partial capture — see Capture coverage" : "✓ Saved complete capture"}</Text>
          <Text>
            {"  "}folder: <Text color="cyan">{finished.dir}</Text>
          </Text>
          <Text>
            {"  "}markdown: <Text color="cyan">{finished.md}</Text>
          </Text>
        </Box>
      )}
      {finished?.ok === false && (
        <Box marginTop={1}>
          <Text color="red">✗ {finished.error}</Text>
        </Box>
      )}
    </Box>
  );
}

/** Prompt for the URL when none was given on the command line. */
function UrlPrompt({ onSubmit }: { onSubmit: (url: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <Box flexDirection="column" paddingY={1}>
      <Text>
        <Text color="cyan" bold>
          xmd
        </Text>{" "}
        — paste a tweet URL:
      </Text>
      <Box>
        <Text color="green">{"› "}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} />
      </Box>
    </Box>
  );
}

function Root({ args }: { args: Args }) {
  const [url, setUrl] = useState<string | undefined>(args.url);
  if (!url) return <UrlPrompt onSubmit={setUrl} />;
  const opts: PipelineOptions = {
    url,
    resume: args.resume,
    transcripts: args.transcripts,
    outBase: args.outBase,
    headless: args.headless,
    enrich: args.enrich,
    scrolls: args.scrolls,
    model: args.model,
    cheapModel: args.cheapModel,
    tiered: args.tiered,
    enrichPosters: args.enrichPosters,
    noCache: args.noCache,
    links: args.links,
    allLinks: args.allLinks,
    categorize: args.categorize,
    category: args.category,
  };
  return <App opts={opts} />;
}

/** Plain (non-TUI) execution path for pipes / CI / --plain. */
async function runPlain(opts: PipelineOptions): Promise<void> {
  for await (const ev of runPipeline(opts)) {
    if (ev.type === "status") console.error(`… ${ev.message}`);
    else if (ev.type === "done") {
      const partial = ev.thread.capture?.status !== "complete";
      if (partial && process.exitCode !== 1) process.exitCode = 2;
      console.error(`${partial ? "⚠ Saved partial capture" : "✓ Saved complete capture"} to ${ev.result.outDir}`);
      console.log(ev.result.outDir);
    } else {
      console.error(`✗ ${ev.error}`);
      process.exitCode = 1;
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    console.log(HELP);
    return;
  }
  if (args.command === "login") {
    await login();
    return;
  }
  if (args.command === "reindex") {
    if (args.reenrich) {
      const enrichOpts = {
        model: args.model,
        cheapModel: args.cheapModel,
        tiered: args.tiered,
        enrichPosters: args.enrichPosters,
        noCache: args.noCache,
        onStatus: (m: string) => console.error(`… ${m}`),
      };
      // Also sweep archive/ — archived bundles are invisible to browse/reindex
      // by design, but a retroactive enrichment fix should still reach them.
      const [primary, archived] = await Promise.all([
        backfillEnrichmentAll(args.outBase, enrichOpts),
        backfillEnrichmentAll(path.join(args.outBase, "archive"), enrichOpts),
      ]);
      const bundlesTouched = primary.bundlesTouched + archived.bundlesTouched;
      const analyzed = primary.analyzed + archived.analyzed;
      const failed = primary.failed + archived.failed;
      console.error(
        `Backfilled enrichment in ${bundlesTouched} bundle(s): ${analyzed} image(s) analyzed${failed ? `, ${failed} still failed` : ""}.`,
      );
    }
    const { updated, skipped } = await reindexAll(args.outBase);
    console.error(`Reindexed ${updated} bundle(s)${skipped ? `, skipped ${skipped} non-bundle dir(s)` : ""}.`);
    return;
  }
  if (args.command === "archive") {
    if (!args.refs.length) {
      console.error("Usage: xmd archive <slug-or-handle> [more...]");
      process.exitCode = 1;
      return;
    }
    const { archived, notFound } = await archiveBundles(args.outBase, args.refs);
    for (const slug of archived) console.error(`✓ Archived ${slug}`);
    for (const ref of notFound) console.error(`✗ No capture matching "${ref}"`);
    if (notFound.length) process.exitCode = 1;
    return;
  }
  if (args.command === "prompt") {
    if (!args.refs.length) {
      console.error("Usage: xmd prompt <category|tweet-url|slug|dir> [more...]");
      process.exitCode = 1;
      return;
    }
    const { text, count, notFound } = await buildAgentPrompt(args.outBase, args.refs);
    for (const ref of notFound) console.error(`✗ No capture matching "${ref}"`);
    if (!count) {
      process.exitCode = 1;
      return;
    }
    console.log(text);
    if (process.stdout.isTTY && (await copyToClipboard(text))) {
      console.error(`✓ Copied to clipboard (${count} capture${count === 1 ? "" : "s"}).`);
    }
    if (notFound.length) process.exitCode = 1;
    return;
  }
  if (args.command === "read" || args.command === "browse") {
    await runReader(args.outBase, args.mermaid, args.command === "read" ? args.url : undefined);
    return;
  }

  const opts: PipelineOptions = {
    url: args.url ?? "",
    resume: args.resume,
    transcripts: args.transcripts,
    outBase: args.outBase,
    headless: args.headless,
    enrich: args.enrich,
    scrolls: args.scrolls,
    model: args.model,
    cheapModel: args.cheapModel,
    tiered: args.tiered,
    enrichPosters: args.enrichPosters,
    noCache: args.noCache,
    links: args.links,
    allLinks: args.allLinks,
    categorize: args.categorize,
    category: args.category,
  };

  if (args.command === "batch") {
    const input = args.inputFile ? await fs.readFile(path.resolve(args.inputFile), "utf8") : args.refs.join(" ");
    for await (const event of runBatch(input, opts)) {
      if (event.type === "status") console.error(`… ${event.message}`);
      else if (event.type === "error") { console.error(`✗ ${event.error}`); process.exitCode = 1; }
      else if (event.type === "done") {
        console.log(event.result.outDir);
        if (event.thread.capture?.status !== "complete" && process.exitCode !== 1) process.exitCode = 2;
      } else {
        console.error(`Batch report: ${event.path}`);
        const count = (status: string) => event.report.items.filter((item) => item.status === status).length;
        console.error(`${count("complete")} complete, ${count("partial")} partial, ${count("failed")} failed.`);
      }
    }
    return;
  }

  // No TUI when piped or explicitly requested — but we still need a URL.
  if ((args.plain || !process.stdout.isTTY) && args.url) {
    await runPlain(opts);
    return;
  }

  render(<Root args={args} />);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
