/**
 * Enrich downloaded images by delegating to a local `claude -p` session:
 * OCR, diagram-to-mermaid, and descriptive alt-text — in a single call per
 * image. Vision happens via Claude reading the local file with its Read tool.
 *
 * The subprocess is deliberately isolated from the user's everyday Claude Code
 * environment: `--strict-mcp-config` keeps connected MCP servers out, a pinned
 * model keeps results stable, and a throwaway cwd avoids pulling in a project
 * `CLAUDE.md`. Results are cached by image content hash so re-runs are cheap.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { imageSize } from "./imagesize.js";
import { allTweets } from "./x-parse.js";
import { preflightClaude, type ProviderStatus } from "./provider.js";
import type { ImageEnrichment, Thread, MediaItem } from "./types.js";

/**
 * Two model tiers. The cheap tier handles the common cases (plain-text
 * transcription, decorative images) and every Mermaid repair; the strong tier
 * is reserved for structured renderings (flowchart/diagram/table) where layout
 * fidelity actually pays for the extra cost. Override either with the matching
 * env var. See `enrichOne` for the escalation rule.
 */
const DEFAULT_MODEL = process.env.TWEETMD_ENRICH_MODEL ?? "claude-sonnet-4-6";
const DEFAULT_CHEAP_MODEL = process.env.TWEETMD_ENRICH_CHEAP_MODEL ?? "claude-haiku-4-5";

/**
 * Kinds whose value is in their structure, not just their text — worth
 * escalating from the cheap tier to the strong model for a faithful rendering.
 */
const STRUCTURAL_KINDS = new Set<ImageEnrichment["kind"]>(["flowchart", "diagram", "table"]);

/**
 * Below this longest-edge size an image is an icon/emoji/avatar — no text or
 * structure worth a vision call. Images we can't measure are enriched anyway
 * (fail open). Keep conservative: real X media is hundreds of pixels wide.
 */
const MIN_ENRICH_DIMENSION = 48;

/** Where enrichment results are cached, keyed by image content hash. */
const CACHE_DIR = path.join(os.homedir(), ".tweetmd", "enrich-cache");

interface ImageContext {
  /** Author-supplied alt text, if any. */
  altText?: string;
  /** Surrounding tweet/article text, to disambiguate what the image shows. */
  surroundingText?: string;
}

const PROMPT = (absPath: string, ctx: ImageContext) => {
  const contextBlock = [
    ctx.altText ? `Author-supplied alt text: ${ctx.altText}` : "",
    ctx.surroundingText
      ? `Surrounding post text (for context, do not transcribe it):\n${ctx.surroundingText}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return `You are converting an image attached to a tweet into the most useful TEXT representation, so a reader (human or AI) who cannot see the image loses nothing. Use the Read tool to view the image file at ${absPath}.
${contextBlock ? `\n${contextBlock}\n` : ""}
First decide what KIND of image it is, then render it accordingly:
- A flowchart, process, sequence, or state machine with directional arrows → render it as a Mermaid diagram inside a \`\`\`mermaid code fence (\`flowchart\`, \`sequenceDiagram\`, or \`stateDiagram-v2\`).
- A table, grid, matrix, or comparison → render it as a GitHub-flavored Markdown table.
- A slide, screenshot of text, document, code, or a labeled chart/figure — anything whose value is its text or structure → transcribe it faithfully as Markdown (use headings, lists, bold, code fences as appropriate; include ALL visible text and preserve structure).
- Any other structured visual (mind map, tree, graph, Venn, org chart, architecture) → render it as the closest-fitting Mermaid diagram (\`mindmap\`, \`graph\`, etc.) inside a \`\`\`mermaid fence.
- A purely decorative image, logo, meme, or photo with no meaningful text or structure → no text rendering is needed.

Mermaid rules (the output must PARSE): keep node ids simple (letters/digits); put any label containing spaces, punctuation, parentheses, %, or quotes inside double quotes, e.g. \`A["Step 1 (init)"]\`; do not nest unescaped double quotes inside a quoted label; for a line break inside a label use \`<br/>\`, never a literal \`\\n\`.

Respond with ONLY one JSON object and nothing else (no prose, no surrounding code fences). Keys:
- "kind": one of "flowchart", "table", "text", "diagram", "decorative".
- "description": a 1-2 sentence plain description of the image. Always provide this.
- "content": the textual rendering described above, as a single Markdown string. For a flowchart/diagram it MUST include the \`\`\`mermaid fence. Use null only when kind is "decorative".

Return only the JSON object.`;
};

export interface EnrichOptions {
  concurrency?: number;
  /** Shared once-per-run authentication/request preflight. */
  provider?: ProviderStatus;
  /** Retry only missing/failed enrichment, preserving completed results. */
  resume?: boolean;
  /** Override the claude binary (defaults to "claude"). */
  claudeBin?: string;
  /** Override the strong model (defaults to TWEETMD_ENRICH_MODEL or a pinned model). */
  model?: string;
  /** Override the cheap first-pass / repair model (defaults to TWEETMD_ENRICH_CHEAP_MODEL). */
  cheapModel?: string;
  /**
   * Run the cheap model first and escalate to the strong model only for
   * structured images (default: true). Set false to use the strong model for
   * every image.
   */
  tiered?: boolean;
  /**
   * Also enrich video/GIF poster frames (default: false). Posters are almost
   * always photographic with no structured text, so they're skipped by default
   * to save a vision call each.
   */
  enrichPosters?: boolean;
  /** Skip the on-disk content-hash cache. */
  noCache?: boolean;
  onStatus?: (message: string) => void;
}

/** Pull the first {...} JSON object out of arbitrary model text. */
function extractJson(text: string): any | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function isValidEnrichment(value: ImageEnrichment | undefined): value is ImageEnrichment {
  return !!value && KINDS.includes(value.kind as typeof KINDS[number]) && !!value.description?.trim()
    && (value.kind === "decorative" || !!value.content?.trim());
}

const KINDS = ["flowchart", "table", "text", "diagram", "decorative"] as const;

/**
 * Within ```mermaid fences, turn a literal `\n` (backslash-n, which models often
 * emit for a label line break) into `<br/>` — Mermaid renders `\n` verbatim, so
 * left alone it shows up as the text "\n" inside a node. Scoped to mermaid
 * blocks so we never touch escape sequences in a code transcription.
 */
function normalizeMermaid(content: string): string {
  return content.replace(/```mermaid\n([\s\S]*?)```/g, (_full, body: string) => {
    return "```mermaid\n" + body.replace(/\\n/g, "<br/>") + "```";
  });
}

/**
 * A table transcription never legitimately ends in "}" — occasionally the
 * model's JSON envelope leaks a stray closing brace onto the end of the last
 * cell. Strip it; scoped to "table" so a genuine `}` inside prose/code isn't
 * touched.
 */
function stripStrayTableBrace(content: string, kind: string | undefined): string {
  return kind === "table" ? content.replace(/\}+\s*$/, "") : content;
}

function coerceEnrichment(parsed: any): ImageEnrichment {
  const kind = KINDS.includes(parsed?.kind) ? parsed.kind : undefined;
  const rawContent =
    typeof parsed?.content === "string" && parsed.content.trim() ? parsed.content : undefined;
  return {
    kind,
    description: typeof parsed?.description === "string" ? parsed.description : undefined,
    content: rawContent ? normalizeMermaid(stripStrayTableBrace(rawContent, kind)) : undefined,
  };
}

/**
 * Structural lint of Mermaid blocks embedded in `content`. This is a cheap
 * sanity check (not a full parse): it catches the breakages we see most often
 * — an unknown diagram header or unbalanced brackets/quotes — so we can ask the
 * model to repair them before they land in the bundle. Returns the first
 * problem found, or null when every block looks well-formed.
 */
function lintMermaid(content: string | undefined): string | null {
  if (!content) return null;
  const blocks = [...content.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  const headers =
    /^(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|classDiagram|erDiagram|mindmap|gantt|pie|journey|gitGraph|timeline|quadrantChart|xychart-beta)\b/;
  for (const block of blocks) {
    const body = block.trim();
    if (!body) return "empty mermaid block";
    const firstLine = body.split("\n")[0].trim();
    if (!headers.test(firstLine)) return `unrecognized mermaid header: "${firstLine}"`;
    for (const [open, close] of [
      ["[", "]"],
      ["(", ")"],
      ["{", "}"],
    ] as const) {
      const opens = body.split(open).length - 1;
      const closes = body.split(close).length - 1;
      if (opens !== closes) return `unbalanced "${open}${close}" in mermaid block`;
    }
    if ((body.split('"').length - 1) % 2 !== 0) return "odd number of double quotes in mermaid block";
  }
  return null;
}

const REPAIR_PROMPT = (content: string, problem: string) =>
  `The following Markdown contains a Mermaid diagram that fails to parse (${problem}). Fix ONLY the Mermaid syntax so it renders, preserving all labels and structure. Quote any label with spaces or punctuation as \`id["label"]\`. Respond with ONLY the corrected Markdown (keep the \`\`\`mermaid fence), nothing else.\n\n${content}`;

/**
 * Cheap, safe deterministic fixes applied inside ```mermaid fences before we
 * pay for an LLM repair: smart quotes → straight quotes (a frequent cause of
 * "odd number of double quotes") and literal `\n` → `<br/>`. Anything riskier
 * (rebalancing brackets, re-quoting labels) is left to the model, which is why
 * the caller re-lints and only escalates if a problem remains.
 */
function tidyMermaid(content: string): string {
  return content.replace(/```mermaid\n([\s\S]*?)```/g, (_full, body: string) => {
    const fixed = body
      .replace(/[“”]/g, '"') // “ ” → "
      .replace(/[‘’]/g, "'") // ‘ ’ → '
      .replace(/\\n/g, "<br/>");
    return "```mermaid\n" + fixed + "```";
  });
}

/** A single vision call should never take this long; a hung `claude -p` would
 * otherwise block its worker slot (and, pre-fix, the whole capture) forever. */
const CLAUDE_CALL_TIMEOUT_MS = 120_000;

interface ClaudeTextResult {
  text: string | null;
  /** Set when `text` is null, so callers can log *why* instead of failing silently. */
  error?: string;
}

function runClaudeText(
  bin: string,
  model: string,
  prompt: string,
  cwd: string,
  allowRead: boolean,
): Promise<ClaudeTextResult> {
  return new Promise((resolve) => {
    // The prompt goes in via stdin, NOT as a positional arg: `--allowedTools`
    // is variadic and greedily swallows a trailing positional as a tool name.
    const args = ["-p", "--model", model, "--strict-mcp-config", "--output-format", "json"];
    if (allowRead) args.push("--allowedTools", "Read");
    const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], cwd });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (result: ClaudeTextResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Drain stderr even though we don't stream it — an unread pipe fills its
    // OS buffer and makes the child block on write(), hanging indefinitely.
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish({ text: null, error: "timed out waiting for claude -p" });
    }, CLAUDE_CALL_TIMEOUT_MS);
    proc.on("error", (e) => finish({ text: null, error: e.message }));
    proc.on("close", (code) => {
      // `--output-format json` wraps the reply: { result: "<text>", ... }
      const wrapper = extractJson(out);
      if (wrapper?.is_error || code !== 0) return finish({ text: null, error: /auth|oauth|sign.?in|logged.?in/i.test(`${wrapper?.result ?? ""} ${err}`) ? "Claude authentication failed." : "Claude image request failed." });
      if (wrapper && typeof wrapper.result === "string") return finish({ text: wrapper.result });
      if (out) return finish({ text: out });
      finish({ text: null, error: err.trim() || `claude exited with code ${code} and no output` });
    });
    proc.stdin.on("error", () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

async function repairMermaid(
  bin: string,
  model: string,
  cwd: string,
  content: string,
  problem: string,
): Promise<string | null> {
  const { text } = await runClaudeText(bin, model, REPAIR_PROMPT(content, problem), cwd, false);
  if (!text) return null;
  const fence = text.match(/```mermaid[\s\S]*```/);
  const fixed = fence ? fence[0] : text.trim();
  return lintMermaid(fixed) ? null : fixed;
}

interface EnrichPassResult {
  enrichment: ImageEnrichment | null;
  /** Set when both attempts failed, so the caller can log why. */
  error?: string;
}

/** One understanding pass on a single model: 2 retries, parse, coerce. No repair. */
async function runEnrichPass(
  bin: string,
  model: string,
  cwd: string,
  absPath: string,
  ctx: ImageContext,
): Promise<EnrichPassResult> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, error } = await runClaudeText(bin, model, PROMPT(absPath, ctx), cwd, true);
    if (error) {
      lastError = error;
      if (/auth|oauth|sign.?in/i.test(error)) break;
      continue;
    }
    const parsed = text ? extractJson(text) : null;
    if (!parsed) {
      lastError = `no valid JSON in response: ${(text ?? "").slice(0, 200)}`;
      continue;
    }
    const enrichment = coerceEnrichment(parsed);
    if (!isValidEnrichment(enrichment)) {
      lastError = "Image response did not contain a valid kind, description and content.";
      continue;
    }
    return { enrichment };
  }
  return { enrichment: null, error: lastError };
}

/**
 * Enrich a single image. When `tiered`, the cheap model runs first and we only
 * re-run on the strong model for structured kinds (flowchart/diagram/table),
 * where the strong model's layout fidelity is worth the extra call. Mermaid is
 * tidied deterministically and, only if a problem remains, repaired by the
 * cheap model (a narrow syntax-fix task that doesn't need the strong tier).
 */
async function enrichOne(
  bin: string,
  strongModel: string,
  cheapModel: string,
  tiered: boolean,
  absPath: string,
  ctx: ImageContext,
): Promise<EnrichPassResult> {
  const cwd = os.tmpdir(); // isolate from any project CLAUDE.md
  const firstModel = tiered ? cheapModel : strongModel;
  const first = await runEnrichPass(bin, firstModel, cwd, absPath, ctx);
  if (!first.enrichment) return first;
  let e = first.enrichment;

  if (tiered && firstModel !== strongModel && STRUCTURAL_KINDS.has(e.kind)) {
    const strong = await runEnrichPass(bin, strongModel, cwd, absPath, ctx);
    if (strong.enrichment) e = strong.enrichment; // strong tier wins for structured renderings
  }

  if (e.content) {
    let content = e.content;
    let problem = lintMermaid(content);
    if (problem) {
      const tidied = tidyMermaid(content);
      if (tidied !== content && !lintMermaid(tidied)) {
        content = tidied; // deterministic fix was enough — no LLM call
        problem = null;
      }
    }
    if (problem) {
      const repaired = await repairMermaid(bin, cheapModel, cwd, content, problem);
      if (repaired) content = normalizeMermaid(repaired);
      else return { enrichment: null, error: `Image diagram could not be repaired: ${problem}` };
    }
    e.content = content;
  }
  return { enrichment: e };
}

// Bump when the prompt, kinds, mermaid lint/repair/normalize logic, or model
// tiering changes, so entries cached by an older build are not reused.
const CACHE_VERSION = "4";

/**
 * Cache key for an enrichment: the image bytes plus everything else that affects
 * the result — the model configuration (which tier(s) could produce it), the
 * per-image context (alt text + surrounding post text), and the cache version.
 * Keying on bytes alone would reuse a result computed under a different model
 * config or a different caption. The buffer is already read by the caller.
 */
function cacheKey(buf: Buffer, modelConfig: string, ctx: ImageContext): string {
  return createHash("sha256")
    .update(buf)
    .update(`\0${CACHE_VERSION}\0${modelConfig}\0${ctx.altText ?? ""}\0${ctx.surroundingText ?? ""}`)
    .digest("hex");
}

async function readCache(hash: string): Promise<ImageEnrichment | null> {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, `${hash}.json`), "utf8");
    const e = JSON.parse(raw) as ImageEnrichment;
    // Normalize on read so entries cached before a fix get corrected for free.
    if (e.content) e.content = stripStrayTableBrace(normalizeMermaid(e.content), e.kind);
    return isValidEnrichment(e) && !lintMermaid(e.content) ? e : null;
  } catch {
    return null;
  }
}

async function writeCache(hash: string, e: ImageEnrichment): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, `${hash}.json`), JSON.stringify(e), "utf8");
  } catch {
    /* caching is best-effort */
  }
}

export interface EnrichSummary {
  /** Images successfully enriched, including cache hits. */
  analyzed: number;
  /** Images where both attempts failed to produce usable JSON (see status log for why). */
  failed: number;
  skipped?: number;
  providerError?: string;
}

/**
 * Enrich every downloaded photo in the thread, mutating each MediaItem with an
 * `enrichment` field. No-op (with a warning) if `claude` isn't available.
 */
export async function enrichImages(
  thread: Thread,
  outDir: string,
  opts: EnrichOptions = {},
): Promise<EnrichSummary> {
  const bin = opts.claudeBin ?? "claude";
  const strongModel = opts.model ?? DEFAULT_MODEL;
  const cheapModel = opts.cheapModel ?? DEFAULT_CHEAP_MODEL;
  const tiered = opts.tiered !== false;
  const enrichPosters = opts.enrichPosters ?? false;
  const status = opts.onStatus ?? (() => {});
  const concurrency = opts.concurrency ?? 3;
  // Encodes every model that could produce the cached result, so flipping
  // --no-tiered or swapping a model invalidates stale entries.
  const modelConfig = tiered ? `${cheapModel}>${strongModel}` : strongModel;

  interface Target {
    absPath: string;
    media: MediaItem;
    ctx: ImageContext;
    apply: (e: ImageEnrichment) => void;
  }
  const targets: Target[] = [];
  let skippedPosters = 0;
  for (const tweet of allTweets(thread)) {
    for (const m of tweet.media) {
      if (opts.resume && isValidEnrichment(m.enrichment)) continue;
      delete m.enrichmentError;
      delete m.enrichmentSkipped;
      if (!m.localPath) continue;
      // Video/GIF poster frames are photographic with no structured text —
      // skip them by default rather than spend a vision call on each.
      if (!enrichPosters && m.type !== "photo") {
        m.enrichmentSkipped = "Video/GIF poster OCR was not requested.";
        skippedPosters++;
        continue;
      }
      targets.push({
        absPath: path.resolve(outDir, m.localPath),
        media: m,
        ctx: {
          altText: m.altText,
          surroundingText: tweet.text ? tweet.text.slice(0, 1500) : undefined,
        },
        apply: (e) => { m.enrichment = e; delete m.enrichmentError; delete m.enrichmentSkipped; },
      });
    }
  }
  if (skippedPosters > 0) {
    status(`Skipping ${skippedPosters} video/GIF poster frame(s) (use --enrich-posters to include).`);
  }

  if (targets.length === 0) return { analyzed: 0, failed: 0 };

  // Main post and article diagrams start before incidental reply images.
  const primaryMedia = new Set([thread.main, ...thread.ancestors, ...thread.replies.filter((t) => t.author.handle.toLowerCase() === thread.main.author.handle.toLowerCase())].flatMap((t) => t.media));
  targets.sort((a, b) => Number(primaryMedia.has(b.media) || b.media.inline) - Number(primaryMedia.has(a.media) || a.media.inline));
  let providerPromise: Promise<ProviderStatus> | undefined;
  const provider = () => providerPromise ??= opts.provider ? Promise.resolve(opts.provider) : preflightClaude(bin);
  let providerError: string | undefined;
  let done = 0;
  let analyzed = 0;
  let failed = 0;
  let skippedTiny = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const t = targets[cursor++];
      const buf = await fs.readFile(t.absPath).catch(() => null);
      // Tiny images are icons/emoji/avatars — no text or structure to extract.
      // Fail open: an unreadable or unmeasurable image is still enriched.
      const dim = buf ? imageSize(buf) : null;
      if (dim && Math.max(dim.width, dim.height) < MIN_ENRICH_DIMENSION) {
        t.media.enrichmentSkipped = "Icon-sized image has no OCR target.";
        skippedTiny++;
        done++;
        status(`Analyzing images ${done}/${targets.length}…`);
        continue;
      }

      let e: ImageEnrichment | null = null;
      const key = !opts.noCache && buf ? cacheKey(buf, modelConfig, t.ctx) : null;
      if (key) e = await readCache(key);
      if (!e) {
        const access = await provider();
        if (!access.available) {
          providerError = access.error ?? "Claude provider is unavailable.";
          t.media.enrichmentError = providerError;
          failed++;
          done++;
          continue;
        }
        const result = await enrichOne(bin, strongModel, cheapModel, tiered, t.absPath, t.ctx);
        e = result.enrichment;
        if (!e && /auth|oauth|sign.?in/i.test(result.error ?? "")) {
          providerError = result.error;
          providerPromise = Promise.resolve({ available: false, authenticated: false, error: providerError });
        }
        if (e && key) await writeCache(key, e);
        if (!e) t.media.enrichmentError = result.error ?? "Image analysis failed.";
        if (!e) status(`Image analysis failed for ${path.basename(t.absPath)}: ${result.error ?? "unknown error"}`);
      }
      if (e) {
        t.apply(e);
        analyzed++;
      } else failed++;
      done++;
      status(`Analyzing images ${done}/${targets.length}…`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  if (skippedTiny > 0) status(`Skipped ${skippedTiny} icon-sized image(s).`);
  if (failed > 0) status(`Image analysis failed for ${failed}/${targets.length} image(s) — see above for reasons.`);
  if (providerError) status(providerError);
  return { analyzed, failed, skipped: skippedPosters + skippedTiny, providerError };
}
