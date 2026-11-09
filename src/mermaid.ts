/**
 * Turn ```mermaid code fences into something the reader can actually show
 * (mdcat renders a mermaid fence as literal code). Two modes:
 *
 *   "ascii"  (default) — render to terminal Unicode box-drawing art via the
 *             `termaid` CLI (`uvx termaid`). Works in any terminal, fully
 *             offline, text-selectable. Output is wrapped in a plain code fence
 *             so mdcat shows it verbatim and monospaced.
 *   "image"  — rasterize to a PNG via mermaid.ink and swap in an image ref, for
 *             higher-fidelity diagrams in a graphics-capable terminal (needs
 *             network on a cache miss). termaid clips long edge labels in LR
 *             flowcharts, so this is the better choice for flowchart-heavy
 *             captures.
 *   "off"    — leave the source fence untouched.
 *
 * Every render is cached by content hash under ~/.tweetmd/mermaid-cache, and any
 * failure leaves the original code block in place — best-effort, never
 * destructive.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type MermaidMode = "ascii" | "image" | "off";

const CACHE_DIR = path.join(os.homedir(), ".tweetmd", "mermaid-cache");
const MERMAID_RE = /```mermaid\n([\s\S]*?)```/g;
// Render PNGs large so the terminal scales them up to fill the width and the
// text stays legible — mermaid.ink's default render is only a few hundred px.
const MERMAID_PNG_WIDTH = 2400;

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

// ── ascii (termaid) ─────────────────────────────────────────────────────────

/** Locate a way to run termaid: a `termaid` on PATH, else `uvx termaid`. */
let termaidCmd: Promise<string[] | null> | undefined;
function detectTermaid(): Promise<string[] | null> {
  if (!termaidCmd) {
    termaidCmd = (async () => {
      for (const cmd of [["termaid"], ["uvx", "termaid"]]) {
        if (await canRun(cmd[0], [...cmd.slice(1), "--version"])) return cmd;
      }
      return null;
    })();
  }
  return termaidCmd;
}

function canRun(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

/** Pipe `code` to a command's stdin and capture stdout, or null on failure. */
function runFilter(bin: string, args: string[], code: string): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve(null));
    p.on("close", (status) => resolve(status === 0 ? out : null));
    p.stdin.on("error", () => {});
    p.stdin.write(code);
    p.stdin.end();
  });
}

/** Render a diagram to box-drawing art via termaid, cached by code + width. */
async function renderAscii(
  code: string,
  cols: number,
  onStatus: (m: string) => void,
): Promise<string | null> {
  const dest = path.join(CACHE_DIR, `${hash(`${code}|ascii|${cols}`)}.txt`);
  try {
    return await fs.readFile(dest, "utf8");
  } catch {
    /* cache miss → render */
  }
  const cmd = await detectTermaid();
  if (!cmd) return null;
  onStatus("Rendering diagram…");
  const out = await runFilter(cmd[0], [...cmd.slice(1), "--width", String(cols)], code);
  const art = out?.replace(/\s+$/, "");
  if (!art) return null;
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(dest, art, "utf8").catch(() => {});
  return art;
}

/** `<br/>` is a mermaid label line break; termaid shows it literally, so flatten it. */
function stripBreaks(code: string): string {
  return code.replace(/<br\s*\/?>/gi, " ");
}

/**
 * Rewrite a left-to-right flowchart to top-down. A terminal can only be so wide,
 * so an `LR` chart packs every node into one row and the text shrinks; `TD` lays
 * the flow out vertically (arrows point down), which is narrow and tall and
 * leaves each node far more width — much more legible. Only the top-level
 * `flowchart`/`graph` direction is touched; subgraph `direction` lines (which
 * give a nice row-per-subgraph wrap) are left alone.
 */
function forceTopDown(code: string): string {
  return code.replace(/\b(flowchart|graph)[ \t]+(LR|RL|BT|TB)\b/, "$1 TD");
}

/** Widest line (in cells) — box-drawing chars are single-width. */
function maxLineWidth(s: string): number {
  return s.split("\n").reduce((w, l) => Math.max(w, [...l].length), 0);
}

// ── image (mermaid.ink) ─────────────────────────────────────────────────────

async function renderImage(code: string, onStatus: (m: string) => void): Promise<string | null> {
  // Key on the render width too, so bumping it invalidates the smaller cache.
  const dest = path.join(CACHE_DIR, `${hash(`${code}|png|${MERMAID_PNG_WIDTH}`)}.png`);
  if (await exists(dest)) return dest;
  onStatus("Rendering diagram…");
  const encoded = Buffer.from(code, "utf8").toString("base64url");
  try {
    const res = await fetch(
      `https://mermaid.ink/img/${encoded}?type=png&theme=dark&width=${MERMAID_PNG_WIDTH}`,
    );
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(dest, buf);
    return dest;
  } catch {
    return null;
  }
}

// ── orchestration ───────────────────────────────────────────────────────────

/**
 * Replace every ```mermaid block in `md` according to `mode`. Blocks that fail
 * to render are left as-is. `onStatus` reports render progress / problems.
 */
export async function inlineMermaid(
  md: string,
  mode: MermaidMode = "ascii",
  onStatus: (message: string) => void = () => {},
): Promise<string> {
  if (mode === "off") return md;
  const blocks = [...md.matchAll(MERMAID_RE)];
  if (blocks.length === 0) return md;
  const cols = Math.max(40, (process.stdout.columns ?? 120) - 2);

  const replacement = new Map<string, string>();
  let misses = 0;
  for (const m of blocks) {
    const full = m[0];
    if (replacement.has(full)) continue;
    // Lay flowcharts out vertically — narrow + tall reads far bigger in a terminal.
    const code = forceTopDown(m[1].trim());
    let rep: string | null = null;

    if (mode === "ascii") {
      // termaid handles simple diagrams (mindmaps, small flowcharts) cleanly but
      // mangles subgraphs and overflows wide flowcharts. Use its art only when it
      // fits the terminal; otherwise fall back to a real rendered PNG.
      const art = await renderAscii(stripBreaks(code), cols, onStatus);
      if (art && maxLineWidth(art) <= cols) {
        rep = "```\n" + art + "\n```"; // fenced → mdcat shows it verbatim/monospaced
      } else {
        const png = await renderImage(code, onStatus); // mermaid.ink handles <br/>, subgraphs
        if (png) rep = `![mermaid diagram](${png})`;
        else if (art) rep = "```\n" + art + "\n```"; // offline + wide: degraded but shown
      }
    } else {
      const png = await renderImage(code, onStatus);
      if (png) rep = `![mermaid diagram](${png})`;
    }

    replacement.set(full, rep ?? full);
    if (!rep) misses++;
  }
  if (misses > 0) {
    const hint =
      mode === "ascii" ? " — is termaid installed? (uvx termaid / pipx install termaid)" : "";
    onStatus(`Couldn't render ${misses} diagram(s)${hint} — showing source.`);
  }

  return md.replace(MERMAID_RE, (full) => replacement.get(full) ?? full);
}
