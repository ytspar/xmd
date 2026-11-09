/**
 * `tweetmd read` / `tweetmd browse` — an Ink browse menu over captured bundles
 * that hands the selected capture to `mdcat` for rendering (inline images +
 * styled text in a graphics-capable terminal). The conversation is folded by
 * default and unfolded on demand (`c`), matching the tweet.md / conversation.md
 * split. mdcat is run with inherited stdio so its Kitty/iTerm2/sixel image
 * escapes reach the real terminal — embedding those inside Ink's frame buffer
 * is not reliable, so the menu and the document render are kept separate.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import React, { useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { inlineMermaid, type MermaidMode } from "./mermaid.js";
import type { Thread } from "./types.js";

interface Summary {
  dir: string;
  slug: string;
  author: string;
  handle: string;
  subject: string;
  date: string;
  replies: number;
  /** ISO capture time, for sorting newest-first. */
  capturedAt: string;
}

/** First readable line of the tweet, stripped of markdown noise and clamped. */
function subjectFrom(text: string | undefined, max = 70): string {
  if (!text) return "(no text)";
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/^[#>*\s-]+/, "").trim())
      .find((l) => l.length > 0) ?? "";
  const clean = line.replace(/\s+/g, " ").trim() || "(no text)";
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function dateOf(thread: Thread): string {
  const raw = thread.main.createdAt;
  if (raw) return raw.slice(0, 10);
  return (thread.main.createdAtRaw || "").slice(0, 10) || "????-??-??";
}

/** Read every bundle's thread.json into a lightweight summary, newest first. */
async function loadSummaries(outBase: string): Promise<Summary[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(outBase, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const summaries = await Promise.all(
    entries.map(async (name): Promise<Summary | null> => {
      const dir = path.join(outBase, name);
      try {
        const thread = JSON.parse(await fs.readFile(path.join(dir, "thread.json"), "utf8")) as Thread;
        return {
          dir,
          slug: name,
          author: thread.main.author.name || thread.main.author.handle,
          handle: thread.main.author.handle,
          subject: subjectFrom(thread.main.text),
          date: dateOf(thread),
          replies: thread.replies?.length ?? 0,
          capturedAt: thread.capturedAt ?? "",
        };
      } catch {
        return null; // not a tweetmd bundle (no/invalid thread.json)
      }
    }),
  );
  return summaries
    .filter((s): s is Summary => s !== null)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

/** Ink list: arrow keys to move, type to filter, Enter to open, Esc to quit. */
function BrowseMenu({
  items,
  onSelect,
  onQuit,
}: {
  items: Summary[];
  onSelect: (s: Summary) => void;
  onQuit: () => void;
}) {
  const { exit } = useApp();
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);

  const f = filter.toLowerCase();
  const shown = f
    ? items.filter(
        (s) =>
          s.author.toLowerCase().includes(f) ||
          s.handle.toLowerCase().includes(f) ||
          s.subject.toLowerCase().includes(f),
      )
    : items;
  const clamped = Math.min(cursor, Math.max(0, shown.length - 1));

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onQuit();
      exit();
      return;
    }
    if (key.return) {
      const pick = shown[clamped];
      if (pick) {
        onSelect(pick);
        exit();
      }
      return;
    }
    if (key.upArrow) return setCursor(Math.max(0, clamped - 1));
    if (key.downArrow) return setCursor(Math.min(shown.length - 1, clamped + 1));
    if (key.backspace || key.delete) {
      setFilter((s) => s.slice(0, -1));
      setCursor(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setFilter((s) => s + input);
      setCursor(0);
    }
  });

  // Window the list so it fits the terminal even with many captures.
  const VIS = Math.max(5, (process.stdout.rows ?? 24) - 6);
  const start = Math.min(Math.max(0, clamped - Math.floor(VIS / 2)), Math.max(0, shown.length - VIS));
  const window = shown.slice(start, start + VIS);

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text>
        <Text color="cyan" bold>
          tweetmd
        </Text>{" "}
        <Text dimColor>
          {shown.length}/{items.length} captures
          {filter ? `  ·  filter: ${filter}` : ""}
        </Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {window.length === 0 && <Text dimColor>{"  "}no matches</Text>}
        {window.map((s) => {
          const sel = s === shown[clamped];
          return (
            <Text key={s.slug} inverse={sel}>
              {sel ? "› " : "  "}
              <Text bold>{s.author}</Text>
              <Text dimColor> @{s.handle}</Text>
              {"  "}
              {s.subject}
              <Text dimColor>
                {"  "}
                {s.date} · 💬{s.replies}
              </Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ move · enter open · type to filter · esc quit</Text>
      </Box>
    </Box>
  );
}

/** Render the menu and resolve with the chosen bundle, or null if quit. */
function pickBundle(items: Summary[]): Promise<Summary | null> {
  return new Promise((resolve) => {
    let settled = false;
    let instance: ReturnType<typeof render> | undefined;
    const done = (v: Summary | null) => {
      if (settled) return;
      settled = true;
      instance?.unmount();
      resolve(v);
    };
    instance = render(
      <BrowseMenu items={items} onSelect={(s) => done(s)} onQuit={() => done(null)} />,
    );
  });
}

const ESC = "";
// Clear screen + scrollback, home the cursor, and delete any placed Kitty
// images so a previous render doesn't ghost behind the next one.
function clearScreen(): void {
  process.stdout.write(`${ESC}[2J${ESC}[3J${ESC}[H${ESC}_Ga=d${ESC}\\`);
}

function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

/** Left-margin padding for readability (text-only renders). */
const LEFT_PAD = "  ";

/** Wrap width that leaves a small right margin; mdcat has no margin option. */
function mdcatCols(): number {
  return Math.max(40, (process.stdout.columns ?? 120) - 4);
}

/** Render flush via inherited stdio — safe for image escapes (which line
 *  indentation would corrupt). */
function runMdcat(files: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("mdcat", ["--columns", String(mdcatCols()), ...files], { stdio: "inherit" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

/** Capture text output and indent every line by a left margin. Only used when
 *  the render has no image escapes — SGR color codes carry no newlines, so a
 *  per-line prefix is safe, but Kitty/iTerm2 image payloads are not. */
function runMdcatIndented(files: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("mdcat", ["--columns", String(mdcatCols())].concat(files), {
      stdio: ["inherit", "pipe", "inherit"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve(false));
    p.on("close", (code) => {
      process.stdout.write(LEFT_PAD + out.replace(/\n/g, "\n" + LEFT_PAD));
      resolve(code === 0);
    });
  });
}

/**
 * Read a single keypress in raw mode so commands (c / q) act immediately — no
 * Enter needed. The catch with raw mode is that the terminal turns mouse-wheel
 * scroll into arrow-key bytes; the original reader resolved on those and quit.
 * Here, any ESC-initiated sequence (arrows, Page Up/Down, mouse, bare Escape)
 * is IGNORED — the reader keeps waiting — so scrolling never triggers a command
 * or exits. Such sequences can arrive split across reads (a lone 0x1b, then the
 * rest), so once we see an ESC byte we swallow whatever follows within a short
 * window rather than resolving on the leading 0x1b. Paired with alternate-scroll
 * disabled (see viewBundle), the wheel scrolls the terminal's scrollback.
 * Returns the key, or "\n" when stdin isn't a TTY.
 */
function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || !stdin.setRawMode) {
      resolve("\n");
      return;
    }
    const prevRaw = stdin.isRaw;
    stdin.setRawMode(true);
    // Ink unref's stdin when the menu unmounts; re-ref so the process stays alive.
    stdin.ref?.();
    stdin.resume();
    let escaping = false;
    let escTimer: ReturnType<typeof setTimeout> | undefined;
    const onData = (buf: Buffer) => {
      // An ESC byte starts a CSI/SS3 sequence (arrows, PgUp/Dn, mouse) that may
      // be delivered in pieces. Swallow the ESC and any bytes that arrive within
      // the debounce window so a split sequence never resolves as a command.
      if (escaping || buf[0] === 0x1b) {
        escaping = true;
        if (escTimer) clearTimeout(escTimer);
        escTimer = setTimeout(() => {
          escaping = false;
        }, 50);
        return;
      }
      if (escTimer) clearTimeout(escTimer);
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(prevRaw ?? false);
      stdin.pause();
      resolve(buf.toString());
    };
    stdin.on("data", onData);
  });
}

/**
 * Build a temp render file beside the bundle (so relative media/ paths still
 * resolve) with mermaid diagrams rasterized inline, then render it with mdcat.
 * Returns false if mdcat could not run.
 */
async function renderDoc(
  tmp: string,
  tweet: string,
  conv: string | null,
  mermaid: MermaidMode,
): Promise<boolean> {
  let md = await fs.readFile(tweet, "utf8").catch(() => "");
  if (conv) md += "\n\n" + (await fs.readFile(conv, "utf8").catch(() => ""));
  md = await inlineMermaid(md, mermaid, (m) => process.stdout.write(m + "\n"));
  await fs.writeFile(tmp, md, "utf8").catch(() => {});
  clearScreen(); // wipe any render-progress lines before drawing the document
  // Indent for readability only when the render is text-only; an image embed
  // ($![...](...)) emits escapes that per-line indentation would corrupt.
  const hasImages = /!\[[^\]]*\]\([^)]+\)/.test(md);
  return hasImages ? runMdcat([tmp]) : runMdcatIndented([tmp]);
}

/**
 * Render one bundle and handle the control keys. Returns "back" to return to
 * the menu or "quit" to exit. `c` toggles the folded conversation.
 */
async function viewBundle(
  dir: string,
  canReturn: boolean,
  mermaid: MermaidMode,
): Promise<"back" | "quit"> {
  const tweet = path.join(dir, "tweet.md");
  const conv = path.join(dir, "conversation.md");
  const hasConv = await exists(conv);
  const tmp = path.join(dir, ".render.md");
  let withConv = false;

  // Disable alternate-scroll so the mouse wheel scrolls scrollback, not arrows.
  process.stdout.write("\x1b[?1007l");

  try {
    while (true) {
      clearScreen();
      const ok = await renderDoc(tmp, tweet, withConv && hasConv ? conv : null, mermaid);
      if (!ok) {
        process.stdout.write(
          "\nCouldn't run `mdcat`. Install it for inline images: brew install mdcat\n" +
            `Raw file: ${tweet}\n`,
        );
      }
      const parts: string[] = ["scroll to read"];
      if (hasConv) parts.push(`[c] ${withConv ? "hide" : "show"} conversation`);
      parts.push(`[enter] ${canReturn ? "back to list" : "done"}`);
      parts.push("[q] quit");

      process.stdout.write(`\n\x1b[2m${parts.join("  ·  ")}\x1b[0m `);
      const k = (await readKey()).toLowerCase();
      if (k === "q" || k === "\x03") return "quit";
      if (k === "c" && hasConv) {
        withConv = !withConv;
        continue;
      }
      return "back";
    }
  } finally {
    // Re-enable alternate-scroll (the common terminal default) we turned off above.
    process.stdout.write("\x1b[?1007h");
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** Resolve a user-supplied bundle reference (path, slug, or prefix) to a dir. */
export async function resolveBundle(outBase: string, ref: string): Promise<string | null> {
  const candidates = [ref, path.join(outBase, ref)];
  for (const c of candidates) {
    if (await exists(path.join(c, "thread.json"))) return c;
  }
  const matches = (await loadSummaries(outBase)).filter(
    (s) => s.slug.includes(ref) || s.handle.toLowerCase().includes(ref.toLowerCase()),
  );
  return matches.length ? matches[0].dir : null;
}

/**
 * Move captures out of the active `browse`/`reindex` set into
 * `<outBase>/archive/`. Since `loadSummaries`/`reindexAll` only read
 * top-level bundle dirs of `outBase`, archived captures are invisible to both
 * without any extra filtering — they still exist on disk for manual lookup.
 */
export async function archiveBundles(
  outBase: string,
  refs: string[],
): Promise<{ archived: string[]; notFound: string[] }> {
  const archiveDir = path.join(outBase, "archive");
  const archived: string[] = [];
  const notFound: string[] = [];
  for (const ref of refs) {
    const dir = await resolveBundle(outBase, ref);
    if (!dir) {
      notFound.push(ref);
      continue;
    }
    await fs.mkdir(archiveDir, { recursive: true });
    const slug = path.basename(dir);
    await fs.rename(dir, path.join(archiveDir, slug));
    archived.push(slug);
  }
  return { archived, notFound };
}

/** Entry point for the `read` / `browse` command. */
export async function runReader(
  outBase: string,
  mermaid: MermaidMode,
  bundleRef?: string,
): Promise<void> {
  if (bundleRef) {
    const dir = await resolveBundle(outBase, bundleRef);
    if (!dir) {
      console.error(`No capture matching "${bundleRef}" under ${outBase}.`);
      process.exitCode = 1;
      return;
    }
    await viewBundle(dir, false, mermaid);
    return;
  }

  // Browse loop: menu → view → back to menu, until quit.
  while (true) {
    const items = await loadSummaries(outBase);
    if (items.length === 0) {
      console.error(`No captures found in ${outBase}. Capture one first: tweetmd <url>`);
      return;
    }
    const pick = await pickBundle(items);
    if (!pick) return;
    const result = await viewBundle(pick.dir, true, mermaid);
    if (result === "quit") return;
  }
}
