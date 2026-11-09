/** Public caption ingestion only: no audio downloads, ASR, cookies or access bypass. */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { decodeEntities } from "./entities.js";

export const CAPTION_PARSER_VERSION = "timed-captions-v2";

export interface CaptionTrack { url: string; language?: string; automatic?: boolean; format?: string }
export interface TranscriptSegment { startSeconds: number; endSeconds: number; text: string }
export interface VideoTranscript {
  /** Identifies timestamp validation semantics; legacy results may omit it. */
  parserVersion?: string;
  status: "complete" | "partial" | "unavailable";
  sourceUrl: string;
  provider: "youtube" | "x" | "vimeo" | "caption-track";
  language?: string;
  automatic?: boolean;
  title?: string;
  captionUrl?: string;
  fetchedAt: string;
  segments: TranscriptSegment[];
  text: string;
  truncated?: boolean;
  error?: string;
}
export interface TranscriptOptions {
  captionTracks?: CaptionTrack[];
  /** Only for caption tracks explicitly discovered in public HTML; generic hosts use guarded web fetching. */
  allowPublicCaptionTracks?: boolean;
  ytDlpBin?: string;
  fetch?: typeof fetch;
  /** Lower limits are useful for callers/tests; hard maxima cannot be increased. */
  maxCharacters?: number;
  timeoutMs?: number;
}
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CHARACTERS = 200_000;
const MAX_SEGMENTS = 20_000;

export function youtubeVideoId(input: string): string | null {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let id: string | null = null;
    if (host === "youtu.be") id = url.pathname.split("/")[1];
    else if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)) {
      id = url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1] ?? null;
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
function recognizedSource(input: string): { url: string; provider: VideoTranscript["provider"] } | null {
  const id = youtubeVideoId(input);
  if (id) return { url: `https://www.youtube.com/watch?v=${id}`, provider: "youtube" };
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) {
      const status = url.pathname.match(/^\/(?:[A-Za-z0-9_]+\/status|i\/status)\/(\d+)(?:\/|$)/)?.[1];
      if (status) return { url: `https://x.com/i/status/${status}`, provider: "x" };
    }
    if (["vimeo.com", "player.vimeo.com"].includes(host)) {
      const videoId = url.pathname.match(/^\/(?:video\/)?(\d+)(?:\/|$)/)?.[1];
      if (videoId) return { url: `https://vimeo.com/${videoId}`, provider: "vimeo" };
    }
    if (host.endsWith(".twimg.com") && /\.(?:mp4|m3u8)$/i.test(url.pathname)) return { url: url.href, provider: "x" };
  } catch { /* Not a public supported video source. */ }
  return null;
}
function captionUrl(input: string): URL {
  const url = new URL(input);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || !(
    host === "youtube.com" || host.endsWith(".youtube.com") || host === "video.google.com" ||
    host.endsWith(".googlevideo.com") || host.endsWith(".twimg.com") || host.endsWith(".vimeocdn.com") || host === "captions.cloud.vimeo.com"
  )) throw new Error("Caption URL is not a supported public caption host.");
  return url;
}
function seconds(value: string | null): number {
  if (value == null || !value.trim()) return NaN;
  value = value.trim();
  if (/^\d+(?:\.\d+)?ms$/.test(value)) return parseFloat(value) / 1000;
  if (/^\d+(?:\.\d+)?s?$/.test(value)) return parseFloat(value);
  // Recognize clock time explicitly; Number("") or arbitrary colon strings must not invent zero.
  if (!/^(?:\d+:)?[0-5]\d:[0-5]\d(?:[.,]\d+)?$/.test(value)) return NaN;
  return value.replace(/,/g, ".").split(":").map(Number).reduce((sum, part) => sum * 60 + part, 0);
}
function milliseconds(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value / 1000 : NaN;
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) / 1000 : NaN;
}
function cleanText(text: string): string {
  return decodeEntities(text.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}
/** Parse YouTube JSON3, WebVTT/SRT, TTML and legacy timed-text XML. */
export function parseCaptionSegments(raw: string): TranscriptSegment[] {
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("Caption document exceeded the size limit.");
  const result: TranscriptSegment[] = [];
  const add = (start: number, end: number, text: string) => {
    text = cleanText(text);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return;
    const previous = result[result.length - 1];
    // Rolling automatic captions repeat or extend an overlapping previous cue.
    if (previous && start < previous.endSeconds && (text === previous.text || text.startsWith(`${previous.text} `))) {
      previous.text = text; previous.endSeconds = Math.max(previous.endSeconds, end); return;
    }
    if (result.length >= MAX_SEGMENTS) throw new Error("Caption document exceeded the segment limit.");
    result.push({ startSeconds: start, endSeconds: end, text });
  };
  if (/^\s*\{/.test(raw)) {
    const json = JSON.parse(raw);
    for (const event of Array.isArray(json.events) ? json.events : []) {
      if (!Array.isArray(event.segs)) continue;
      const start = milliseconds(event.tStartMs);
      add(start, start + milliseconds(event.dDurationMs), event.segs.map((segment: { utf8?: string }) => segment.utf8 ?? "").join(""));
    }
  } else if (/^\s*</.test(raw)) {
    const dom = new JSDOM(raw.replace(/<br\s*\/?\s*>/gi, " "), { contentType: "text/xml" });
    try {
      const document = dom.window.document;
      for (const node of document.querySelectorAll("text, p")) {
        // YouTube srv2/srv3 use t/d in milliseconds; legacy XML and TTML use
        // start/dur or begin/end in seconds/clock time. Missing attributes are not zero.
        const start = node.hasAttribute("t") ? milliseconds(node.getAttribute("t")) : seconds(node.getAttribute("start") ?? node.getAttribute("begin"));
        const duration = node.hasAttribute("d") ? milliseconds(node.getAttribute("d")) : seconds(node.getAttribute("dur"));
        const end = node.hasAttribute("end") ? seconds(node.getAttribute("end")) : start + duration;
        add(start, end, node.textContent ?? "");
      }
    } finally { dom.window.close(); }
  } else {
    const lines = raw.replace(/\r/g, "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const timing = lines[i].match(/^\s*((?:\d+:)?\d{2}:\d{2}[.,]\d+)\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d+)/);
      if (!timing) continue;
      const content: string[] = [];
      while (++i < lines.length && lines[i].trim()) content.push(lines[i]);
      add(seconds(timing[1]), seconds(timing[2]), content.join(" "));
    }
  }
  return result.sort((a, b) => a.startSeconds - b.startSeconds);
}
export function selectCaptionTracks(tracks: CaptionTrack[]): CaptionTrack[] {
  const rank = (track: CaptionTrack) => (/^en(?:-|$)/i.test(track.language ?? "") ? 0 : 2) + (track.automatic ? 1 : 0);
  return tracks.filter((track) => track.language !== "live_chat").sort((a, b) => rank(a) - rank(b) || (a.language ?? "").localeCompare(b.language ?? ""));
}
async function readCaption(url: string, fetcher: typeof fetch, timeoutMs: number, allowPublicTrack = false): Promise<string> {
  if (allowPublicTrack) {
    const target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Caption track must use a public HTTP(S) URL without credentials.");
    // Dynamic import avoids the links -> transcripts -> links initialization cycle.
    const { httpGet } = await import("./links.js");
    const response = await httpGet(target.href, "text/vtt,application/ttml+xml,text/xml,application/json,text/plain", { maxBytes: MAX_BYTES, timeoutMs, retries: 0 });
    if (!response) throw new Error("Public caption track is unavailable or its URL/redirect was blocked.");
    if (response.truncated || response.buf.byteLength > MAX_BYTES) throw new Error("Caption response exceeded the size limit.");
    return response.buf.toString("utf8");
  }
  let current = captionUrl(url);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(current, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Caption redirect has no target.");
      current = captionUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Caption server returned HTTP ${response.status}; public access may be restricted.`); }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_BYTES) throw new Error("Caption response exceeded the size limit.");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("Caption redirect limit reached.");
}
async function publicCaptionMetadata(url: string, bin: string, timeoutMs: number): Promise<{ title?: string; tracks: CaptionTrack[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xmd-caption-"));
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const proc = spawn(bin, ["--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--no-cache-dir", "--skip-download", "--dump-single-json", "--no-playlist", "--no-warnings", "--retries", "0", "--extractor-retries", "0", "--socket-timeout", "10", "--", url], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", bytes = 0, stderr = "", settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { proc.kill("SIGKILL"); reject(error); } else resolve(output);
      };
      const timer = setTimeout(() => finish(new Error("Public caption metadata lookup timed out.")), timeoutMs);
      proc.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) finish(new Error("Video metadata exceeded the size limit.")); else output += chunk.toString(); });
      proc.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
      proc.on("error", () => finish(new Error("yt-dlp is unavailable; install it to read public video captions, or provide public caption tracks.")));
      proc.on("close", (code) => {
        if (code !== 0) {
          const reason = /sign.?in|bot|403|429|private|unavailable|restricted|login|cookies/i.test(stderr)
            ? "Video captions require access that is not publicly available (sign-in, bot check, restriction or HTTP failure)."
            : "Public video metadata lookup failed; check video availability and the installed yt-dlp version.";
          finish(new Error(reason));
        } else finish();
      });
    });
    const metadata = JSON.parse(text);
    const tracks: CaptionTrack[] = [];
    for (const [kind, automatic] of [["subtitles", false], ["automatic_captions", true]] as const) {
      for (const [language, formats] of Object.entries(metadata[kind] ?? {})) {
        if (!Array.isArray(formats)) continue;
        const format = [...formats].sort((a, b) => ["json3", "vtt", "ttml", "srv3", "srv2", "srv1"].indexOf(a.ext) - ["json3", "vtt", "ttml", "srv3", "srv2", "srv1"].indexOf(b.ext)).find((entry) => typeof entry.url === "string" && ["json3", "vtt", "ttml", "srv3", "srv2", "srv1"].includes(entry.ext));
        if (format) tracks.push({ url: format.url, language, automatic, format: format.ext });
      }
    }
    return { title: typeof metadata.title === "string" ? metadata.title : undefined, tracks };
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
export async function fetchVideoTranscript(sourceUrl: string, opts: TranscriptOptions = {}): Promise<VideoTranscript> {
  const source = recognizedSource(sourceUrl);
  const result: VideoTranscript = { status: "unavailable", sourceUrl: source?.url ?? sourceUrl, provider: source?.provider ?? "caption-track", parserVersion: CAPTION_PARSER_VERSION, fetchedAt: new Date().toISOString(), segments: [], text: "" };
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.min(35_000, Math.max(1, opts.timeoutMs!)) : 35_000;
  const deadline = Date.now() + timeoutMs;
  try {
    let tracks = opts.captionTracks ?? [];
    const allowPublicTracks = !!opts.allowPublicCaptionTracks && tracks.length > 0;
    if (!tracks.length) {
      if (!source) throw new Error("Unsupported video source; provide a public YouTube/X URL or public caption track.");
      const metadata = await publicCaptionMetadata(source.url, opts.ytDlpBin ?? "yt-dlp", Math.max(1, deadline - Date.now()));
      result.title = metadata.title;
      tracks = metadata.tracks;
    }
    if (!tracks.length) throw new Error("No public human or automatic caption tracks are available. Audio transcription was not attempted.");
    let lastError = "Public caption tracks contained no readable timed text.";
    for (const track of selectCaptionTracks(tracks).slice(0, 3)) {
      if (Date.now() >= deadline) { lastError = "Public caption lookup timed out."; break; }
      try {
        const raw = await readCaption(track.url, opts.fetch ?? fetch, Math.max(1, deadline - Date.now()), allowPublicTracks);
        const segments = parseCaptionSegments(raw);
        if (!segments.length) { lastError = "Public caption track was empty or contained no readable timed text."; continue; }
        const maximum = Number.isFinite(opts.maxCharacters) ? Math.min(MAX_CHARACTERS, Math.max(1, opts.maxCharacters!)) : MAX_CHARACTERS;
        let used = 0;
        for (const segment of segments) {
          const remaining = maximum - used;
          if (remaining <= 0) { result.truncated = true; break; }
          const text = segment.text.slice(0, remaining);
          result.segments.push({ ...segment, text });
          used += text.length + 1;
          if (text.length < segment.text.length) { result.truncated = true; break; }
        }
        result.text = result.segments.map((segment) => segment.text).join("\n");
        result.status = result.truncated ? "partial" : "complete";
        result.language = track.language;
        result.automatic = track.automatic;
        result.captionUrl = track.url;
        return result;
      } catch (error) { lastError = (error as Error).message; }
    }
    throw new Error(lastError);
  } catch (error) { result.error = (error as Error).message; return result; }
}
function timestamp(value: number): string {
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
export function formatTranscriptMarkdown(result: VideoTranscript): string {
  const lines = [`# ${result.title ?? "Video transcript"}`, "", `Source: <${result.sourceUrl}>`, `Status: ${result.status}`, `Language: ${result.language ?? "unknown"}`, `Captions: ${result.automatic === true ? "automatic" : result.automatic === false ? "human-provided" : "unknown"}`, `Fetched: ${result.fetchedAt}`, `Parser: ${result.parserVersion ?? "legacy / unknown"}`, ""];
  if (result.error) lines.push(`Unavailable: ${result.error}`, "");
  if (result.captionUrl) lines.push(`Caption source: <${result.captionUrl}>`, "");
  if (result.truncated) lines.push("> Partial transcript: character limit reached.", "");
  for (const segment of result.segments) lines.push(`[${timestamp(segment.startSeconds)}–${timestamp(segment.endSeconds)}] ${segment.text}`, "");
  return lines.join("\n");
}
