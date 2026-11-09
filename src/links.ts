/**
 * Follow links found in tweet text and save a local copy of their content, so
 * the bundle carries the actual source — a skill file, a gist, a package
 * README, a blog post — rather than just a pointer, which is what's useful when
 * handing the capture to Claude.
 *
 * Handled: GitHub files, GitHub repos (their README), gists (all files), npm
 * and PyPI packages (metadata + README), and generic web pages (readable text).
 * x.com links, social shorteners, and direct media files are skipped. Generic
 * web pages are followed from the original author's tweets and their quoted or
 * embedded sources; structured
 * sources (GitHub/npm/PyPI/gist) are followed from anyone in the thread.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isIP } from "node:net";
import { canonicalReferenceImageUrl } from "./reference-images.js";
import { publicHttpUrl, publicDispatcher, UnsafePublicUrlError } from "./public-network.js";
import { extractWebDocument, WEB_EXTRACTION_VERSION, hostedVideoUrl } from "./web-document.js";
import { allTweets } from "./x-parse.js";
import { extractRepositoryDocument, REPOSITORY_DOCUMENT_VERSION, REPOSITORY_IMAGE_VERSION } from "./repository-document.js";
import type { LinkedReference, Thread, TweetNode } from "./types.js";

/** Cap a single fetched file so a huge source can't bloat the bundle. */
const MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** Hosts we never fetch as web pages (self-referential / not text). */
const SKIP_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "mobile.twitter.com",
  "t.co",
  "t.me",
  "telegram.me",
  "youtube.com",
  "youtu.be",
  "vimeo.com",
]);

/** A real browser UA — many sites 403 unknown bot agents. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|pdf|zip|tar|gz|tgz|dmg|exe)$/i;

type Kind = LinkedReference["kind"];
interface SourceMetadata {
  finalUrl?: string;
  canonicalUrl?: string;
  title?: string;
  extractionMethod?: "readability" | "semantic" | "body" | "plain-text" | "source";
  extractionVersion?: string;
  resolution?: LinkedReference["resolution"];
  attemptedUrl?: string;
  warning?: string;
  images?: {url:string;altText?:string;caption?:string}[];
  videoUrls?: string[];
  videos?: LinkedReference["videos"];
  imageDiscoveryVersion?: string;
  textStatus?: "complete" | "partial" | "failed";
}
interface FetchedFile {
  name: string;
  text: string;
  truncated: boolean;
  metadata?: SourceMetadata;
}
interface Plan {
  kind: Kind;
  title: string;
  fetch: () => Promise<FetchedFile[]>;
  skipReason?: string;
  video?: boolean;
}

/**
 * Strip trailing punctuation a URL picks up from prose, while keeping balanced
 * parens — so `…/Lisp_(programming_language)` survives but the `)` in
 * `(see https://x.com)` is dropped. Trailing `*`/`_` come from a URL used as
 * its own bold/italic markdown link text, e.g. `[**https://x.com**](...)`.
 * The two kinds of trailing junk can alternate — stripping an unbalanced `)`
 * can expose a `**` underneath it (`...page**)`  →  `...page**`  →  `...page`)
 * — so repeat both passes until neither changes anything.
 */
function cleanUrl(u: string): string {
  let prev: string;
  do {
    prev = u;
    u = u.replace(/[.,;:'"*_]+$/, "");
    if (u.endsWith(")") && u.split(")").length - 1 > u.split("(").length - 1) {
      u = u.slice(0, -1);
    }
  } while (u !== prev);
  return u;
}

/**
 * Article-formatted tweets sometimes spell a link as `[**URL**](URL)` — the
 * label is the URL itself. A plain `https?:\/\/[^\s<>]+` scan starting at the
 * label's URL has no whitespace to stop at and runs straight through `**](`
 * into the target URL, producing one mangled string instead of two clean
 * ones. `](` is a reliable "end of markdown link label" marker that legitimate
 * URL characters essentially never contain, so treat it as a hard stop.
 */
function urlsIn(text: string): string[] {
  return (text.match(/https?:\/\/(?:(?!\]\()[^\s<>])+/g) ?? []).map(cleanUrl);
}

/**
 * Dedup key for a URL: a `#fragment` is client-side and a trailing slash is
 * usually the same page, so both collapse — otherwise `/skills` and
 * `/skills#frontmatter` would be fetched as two copies of the same page.
 * `http`/`https` are also collapsed — the same resource gets posted with
 * either scheme in the wild (e.g. one reply linking `http://github.com/...`
 * and another `https://` the same repo), and fetching it twice just
 * duplicates the saved file. A leading `www.` collapses too, matching
 * `planLink`'s own host handling — otherwise `example.com` and `www.example.com`
 * dedup as two different pages and get fetched (and saved) twice.
 */
function dedupKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    if (u.protocol === "http:") u.protocol = "https:";
    u.hostname = u.hostname.replace(/^www\./, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return url
      .replace(/^http:/, "https:")
      .replace(/^(https?:\/\/)www\./, "$1")
      .split("#")[0]
      .replace(/\/$/, "");
  }
}

// ── low-level fetch ────────────────────────────────────────────────────────

export interface RawResponse {
  buf: Buffer;
  contentType: string;
  finalUrl: string;
  truncated: boolean;
}

/** Hard memory ceiling per response — bounds OOM / gzip-bomb risk before MAX_BYTES storage cap. */
const HARD_CAP = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Read a response body into a Buffer, stopping at HARD_CAP bytes. */
async function readCapped(res: Response, maximum = HARD_CAP): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer()).subarray(0, maximum);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = Buffer.from(value);
    if (total + chunk.byteLength > maximum) {
      chunk = chunk.subarray(0, maximum - total);
      chunks.push(chunk);
      await reader.cancel().catch(() => {});
      break;
    }
    total += chunk.byteLength;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Extra attempts for a transient failure (network error, timeout, 429, 5xx). */
const FETCH_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_000;

/** A failed attempt: `retry` marks it transient, worth trying again. */
interface FetchFailure {
  retry: boolean;
  status?: number;
}

async function httpGetOnce(url: string, accept?: string, limits: {maxBytes:number;deadline?:number} = {maxBytes:HARD_CAP}): Promise<RawResponse | FetchFailure> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let target: URL;
    try {
      target = publicHttpUrl(current);
    } catch {
      return { retry: false };
    }

    const ctrl = new AbortController();
    const remaining = limits.deadline ? limits.deadline - Date.now() : FETCH_TIMEOUT_MS;
    if (remaining <= 0) return {retry:false};
    const timer = setTimeout(() => ctrl.abort(), Math.min(FETCH_TIMEOUT_MS, remaining));
    let dispatcher: Awaited<ReturnType<typeof publicDispatcher>> | undefined;
    try {
      dispatcher = await publicDispatcher(target, ctrl.signal);
      const requestOptions = {
        dispatcher,
        signal: ctrl.signal,
        redirect: "manual" as const, // resolve and pin every redirect independently
        headers: { "user-agent": USER_AGENT, ...(accept ? { accept } : {}) },
      };
      const res = await fetch(current, requestOptions);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { retry: false };
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) return { retry: res.status === 429 || res.status >= 500, status: res.status };
      const buf = await readCapped(res, limits.maxBytes);
      return { buf, contentType: res.headers.get("content-type") ?? "", finalUrl: current, truncated: buf.byteLength >= limits.maxBytes };
    } catch (error) {
      return { retry: !(error instanceof UnsafePublicUrlError) };
    } finally {
      clearTimeout(timer);
      await dispatcher?.destroy();
    }
  }
  return { retry: false }; // too many redirects
}

/** Internal result retains HTTP failures for truthful repository diagnostics. */
async function httpGetResult(url: string, accept?: string, opts: {maxBytes?:number;timeoutMs?:number;retries?:number} = {}): Promise<RawResponse | FetchFailure> {
  const deadline = opts.timeoutMs ? Date.now() + Math.max(1, opts.timeoutMs) : undefined;
  const maxBytes = Math.max(1, Math.min(opts.maxBytes ?? HARD_CAP, HARD_CAP));
  const retries = Math.max(0, Math.min(opts.retries ?? FETCH_RETRIES, FETCH_RETRIES));
  for (let attempt = 0; ; attempt++) {
    const r = await httpGetOnce(url, accept, {maxBytes,deadline});
    if ("buf" in r) return r;
    if (!r.retry || attempt >= retries) return r;
    const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
    if (deadline && Date.now() + delay >= deadline) return r;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** GET with redirect checks, retrying transient failures with backoff. */
export async function httpGet(url: string, accept?: string, opts: {maxBytes?:number;timeoutMs?:number;retries?:number} = {}): Promise<RawResponse | null> {
  const result = await httpGetResult(url, accept, opts);
  return "buf" in result ? result : null;
}

/** Decode a Buffer as UTF-8, capping at MAX_BYTES without splitting a character. */
function decodeCapped(buf: Buffer): { text: string; truncated: boolean } {
  if (buf.byteLength <= MAX_BYTES) return { text: buf.toString("utf8"), truncated: false };
  let end = MAX_BYTES;
  // Back off out of the middle of a multi-byte char (continuation bytes are 10xxxxxx).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

async function getText(url: string, accept?: string): Promise<{ text: string; truncated: boolean; finalUrl: string } | null> {
  const r = await httpGet(url, accept);
  if (!r) return null;
  const result = decodeCapped(r.buf);
  return { ...result, truncated: result.truncated || r.truncated, finalUrl: r.finalUrl };
}

async function getJson<T = any>(url: string): Promise<T | null> {
  const r = await httpGet(url, "application/json");
  if (!r) return null;
  try {
    return JSON.parse(r.buf.toString("utf8")) as T;
  } catch {
    return null;
  }
}

function capped(text: string): { text: string; truncated: boolean } {
  return decodeCapped(Buffer.from(text, "utf8"));
}

// ── per-source fetchers ────────────────────────────────────────────────────

function repositoryDocument(name: string): boolean {
  return /\.(?:md|markdown|mdx|rst)$/i.test(name) || /(?:^|\/)readme(?:\.txt)?$/i.test(name);
}
function githubRawUrl(owner: string, repo: string, ref: string, filePath = ""): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}
function repositoryRoot(rawUrl: string, filePath: string): string {
  const root = new URL(rawUrl);
  root.search = ""; root.hash = "";
  root.pathname = root.pathname.split("/").slice(0, -filePath.split("/").filter(Boolean).length).join("/") + "/";
  return root.toString();
}
function repositoryFile(name: string, sourceName: string, text: string, truncated: boolean,
  baseUrl?: string, rootUrl?: string, warning?: string): FetchedFile {
  const document = repositoryDocument(sourceName) && baseUrl
    ? extractRepositoryDocument(text, baseUrl, rootUrl) : { text, images: [], warning: undefined };
  const warnings = [warning, document.warning,
    repositoryDocument(sourceName) && !baseUrl ? "Repository document base URL could not be verified; relative article images were not resolved." : undefined,
    truncated ? "Repository source text was truncated." : undefined].filter(Boolean);
  const output = capped(document.text);
  if (output.truncated) warnings.push("Extracted repository document exceeded the text storage limit.");
  const combinedWarning = [...new Set(warnings)].join(" ") || undefined;
  return { name, text: output.text, truncated: truncated || output.truncated, metadata: {
    finalUrl: baseUrl, extractionMethod: "source", extractionVersion: REPOSITORY_DOCUMENT_VERSION,
    imageDiscoveryVersion: REPOSITORY_IMAGE_VERSION, images: document.images,
    warning: combinedWarning, textStatus: combinedWarning || truncated || output.truncated ? "partial" : "complete",
  } };
}

/** Raw CDN first, with the contents API as a separate rate-limit fallback. */
async function fetchGithubFile(owner: string, repo: string, ref: string, filePath: string, name: string): Promise<FetchedFile[]> {
  const raw = githubRawUrl(owner, repo, ref, filePath);
  const r = await getText(raw, "text/plain");
  if (r) return [repositoryFile(name, filePath, r.text, r.truncated, raw, githubRawUrl(owner, repo, ref))];
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
  const r2 = await getText(api, "application/vnd.github.raw");
  return r2 ? [repositoryFile(name, filePath, r2.text, r2.truncated, raw, githubRawUrl(owner, repo, ref))] : [];
}

interface GithubReadme { path?: string; download_url?: string | null; content?: string; encoding?: string; truncated?: boolean; size?: number }
async function fetchRepoReadme(owner: string, repo: string, name: string): Promise<FetchedFile[]> {
  const endpoint = `https://api.github.com/repos/${owner}/${repo}/readme`;
  // JSON tells us both the actual README location and default ref. A raw-only
  // response cannot establish a safe base for relative images in a subfolder.
  const info = await getJson<GithubReadme>(endpoint);
  const raw = info?.download_url && /^https:\/\/raw\.githubusercontent\.com\//i.test(info.download_url) ? info.download_url : undefined;
  const sourcePath = info?.path;
  if (raw && sourcePath) {
    let content: { text: string; truncated: boolean } | null = null;
    let incompleteApiContent: { text: string; truncated: boolean } | null = null;
    if (info.encoding === "base64" && typeof info.content === "string" && info.content.length > 0) {
      const decoded = Buffer.from(info.content, "base64");
      const candidate = decodeCapped(decoded);
      if (info.truncated || (typeof info.size === "number" && decoded.byteLength < info.size)) incompleteApiContent = { ...candidate, truncated: true };
      else content = candidate;
    }
    if (!content) content = await getText(raw, "text/plain");
    if (!content) content = await getText(endpoint, "application/vnd.github.raw");
    content ??= incompleteApiContent;
    if (content) return [repositoryFile(name, sourcePath, content.text, content.truncated, raw, repositoryRoot(raw, sourcePath))];
  }
  // Preserve a readable raw API copy even when metadata is unavailable, but
  // explicitly avoid inventing a branch/path and claiming image completeness.
  const api = await getText(endpoint, "application/vnd.github.raw");
  if (api) return [repositoryFile(name, sourcePath ?? "README.md", api.text, api.truncated, undefined, undefined,
    "GitHub README metadata was unavailable; default branch and document path are unverified.")];
  // A real raw response at an explicit path verifies that fallback's base.
  for (const branch of ["main", "master"]) {
    for (const filename of ["README.md", "readme.md"]) {
      const fallback = await getText(githubRawUrl(owner, repo, branch, filename), "text/plain");
      if (fallback) return [repositoryFile(name, filename, fallback.text, fallback.truncated,
        githubRawUrl(owner, repo, branch, filename), githubRawUrl(owner, repo, branch))];
    }
  }
  return [];
}

interface GithubDirectoryEntry { name: string; path: string; type: string }
const DIRECTORY_MAX_DOCUMENTS = 8;
const DIRECTORY_MAX_CHILDREN = 8;
const DIRECTORY_MAX_LISTING_ENTRIES = 64;

function directoryApi(owner: string, repo: string, ref: string, directory: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/contents/${directory.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
}
async function directoryListing(owner: string, repo: string, ref: string, directory: string): Promise<{ entries?: GithubDirectoryEntry[]; failure?: string }> {
  const result = await httpGetResult(directoryApi(owner, repo, ref, directory), "application/json", { timeoutMs: 20_000, retries: 1 });
  if (!("buf" in result)) return { failure: result.status ? `HTTP ${result.status}` : "network failure or timeout" };
  if (result.truncated) return { failure: "response exceeded the directory listing size limit" };
  try {
    const entries: unknown = JSON.parse(result.buf.toString("utf8"));
    if (Array.isArray(entries) && entries.every((entry) => entry && typeof entry.name === "string" && typeof entry.path === "string" && typeof entry.type === "string")) {
      return { entries: entries as GithubDirectoryEntry[] };
    }
  } catch { /* Treat an unexpected API shape as unavailable, not an empty directory. */ }
  return { failure: "response was not a valid directory listing" };
}
function directoryReadme(entries: GithubDirectoryEntry[]): GithubDirectoryEntry | undefined {
  return entries.find((entry) => entry.type === "file" && /^readme(?:\.(?:md|markdown|rst|txt))?$/i.test(entry.name));
}
function githubTreeUrl(owner: string, repo: string, ref: string, directory: string): string {
  return `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(ref)}/${directory.split("/").map(encodeURIComponent).join("/")}`;
}

/** Prefer the exact README; absent one, capture a bounded nearby-documents index. */
async function fetchDirectoryReadme(owner: string, repo: string, ref: string, directory: string): Promise<FetchedFile[]> {
  const listing = await directoryListing(owner, repo, ref, directory);
  const name = `${repo}-${directory.replace(/\//g, "-") || "root"}`;
  if (!listing.entries) {
    const fallback = await fetchGithubFile(owner, repo, ref, `${directory ? directory + "/" : ""}README.md`, `${name}-README.md`);
    if (fallback.length) return fallback;
    throw new Error(`GitHub directory listing unavailable (${listing.failure}); no README was retrieved for ${owner}/${repo}/${directory} at ${ref}. The path may be missing or inaccessible.`);
  }
  const readme = directoryReadme(listing.entries);
  if (readme) {
    const files = await fetchGithubFile(owner, repo, ref, readme.path, `${name}-README.md`);
    if (files.length) return files;
    throw new Error(`GitHub directory exists, but its listed README could not be retrieved: ${owner}/${repo}/${readme.path} at ${ref}.`);
  }
  // A folder such as examples/plugins has no single README. Do not invent one
  // or return GitHub navigation HTML: preserve the verified index and actual
  // first-level documentation, with all scope limits explicit.
  const entries = [...listing.entries].sort((a, b) => a.path.localeCompare(b.path));
  const candidates = entries.filter((entry) => entry.type === "file" && repositoryDocument(entry.path)).slice(0, DIRECTORY_MAX_DOCUMENTS);
  const children = entries.filter((entry) => entry.type === "dir").slice(0, DIRECTORY_MAX_CHILDREN);
  const notes: string[] = [];
  for (const child of children) {
    if (candidates.length >= DIRECTORY_MAX_DOCUMENTS) break;
    const childListing = await directoryListing(owner, repo, ref, child.path);
    if (!childListing.entries) { notes.push(`${child.path}: listing unavailable (${childListing.failure}).`); continue; }
    const childReadme = directoryReadme(childListing.entries);
    const docs = childReadme ? [childReadme] : childListing.entries.filter((entry) => entry.type === "file" && repositoryDocument(entry.path));
    candidates.push(...docs.slice(0, DIRECTORY_MAX_DOCUMENTS - candidates.length));
  }
  const files: FetchedFile[] = [];
  const retrievedPaths: string[] = [];
  for (const candidate of candidates) {
    const fetched = await fetchGithubFile(owner, repo, ref, candidate.path, `${repo}-${candidate.path.replace(/\//g, "-")}`);
    if (fetched.length) { files.push(...fetched); retrievedPaths.push(candidate.path); }
    else notes.push(`${candidate.path}: listed document could not be retrieved.`);
  }
  const source = githubTreeUrl(owner, repo, ref, directory);
  const warning = `Directory has no README; saved a bounded listing and up to ${DIRECTORY_MAX_DOCUMENTS} nearby documents/child READMEs (one level, at most ${DIRECTORY_MAX_CHILDREN} child directories inspected). Other files and deeper directory content were not captured.${entries.length > DIRECTORY_MAX_LISTING_ENTRIES ? ` Listing shows ${DIRECTORY_MAX_LISTING_ENTRIES} of ${entries.length} entries.` : ""}${notes.length ? " Some listed documentation could not be retrieved." : ""}`;
  const rows = entries.slice(0, DIRECTORY_MAX_LISTING_ENTRIES).map((entry) => {
    const target = entry.type === "dir" ? githubTreeUrl(owner, repo, ref, entry.path) : githubRawUrl(owner, repo, ref, entry.path);
    return `- [${entry.name}](${target}) (${entry.type})`;
  });
  const index = [`# ${owner}/${repo}: ${directory || "/"}`, `<${source}>`,
    `Verified directory listing: <${directoryApi(owner, repo, ref, directory)}>`, warning,
    `## Directory entries (${entries.length} total)`, rows.join("\n"),
    "## Retrieved documents", retrievedPaths.map((sourcePath) => `- ${sourcePath}`).join("\n") || "No nearby documents were retrieved.",
    notes.length ? "## Unavailable documentation\n\n" + notes.join("\n") : ""].filter(Boolean).join("\n\n");
  return [repositoryFile(`${name}-index.md`, "index.md", index, false, source, githubRawUrl(owner, repo, ref), warning), ...files];
}

async function fetchGist(user: string, id: string): Promise<FetchedFile[]> {
  const api = await getJson<{ files: Record<string, { filename: string; content: string; truncated: boolean; raw_url: string }> }>(
    `https://api.github.com/gists/${id}`,
  );
  if (api?.files) {
    const out: FetchedFile[] = [];
    for (const f of Object.values(api.files)) {
      let text = f.content ?? "";
      let truncated = false;
      if (f.truncated && f.raw_url) {
        const full = await getText(f.raw_url, "text/plain");
        if (full) { text = full.text; truncated = full.truncated; }
        else truncated = true;
      } else ({ text, truncated } = capped(text));
      const filename = f.filename || `gist-${id}.txt`;
      const root = f.raw_url ? new URL(".", f.raw_url).toString() : undefined;
      out.push(repositoryFile(filename, filename, text, truncated, f.raw_url, root));
    }
    if (out.length) return out;
  }
  // Redirects on the raw endpoint identify its filename/base when API fails.
  const raw = await getText(`https://gist.github.com/${user}/${id}/raw`, "text/plain");
  if (!raw) return [];
  const filename = new URL(raw.finalUrl).pathname.split("/").pop() || `gist-${id}.txt`;
  return [repositoryFile(filename, filename, raw.text, raw.truncated, raw.finalUrl, new URL(".", raw.finalUrl).toString())];
}

async function fetchNpm(name: string): Promise<FetchedFile[]> {
  const enc = name.startsWith("@") ? name.replace("/", "%2F") : name;
  const data = await getJson<any>(`https://registry.npmjs.org/${enc}`);
  if (!data) return [];
  const latest = data["dist-tags"]?.latest;
  const v = latest ? data.versions?.[latest] : undefined;
  const repo = typeof data.repository === "string" ? data.repository : data.repository?.url;
  const md = [
    `# npm: ${name}${latest ? `@${latest}` : ""}`,
    "",
    `<https://www.npmjs.com/package/${name}>`,
    "",
    v?.description || data.description || "",
    data.homepage ? `\nHomepage: ${data.homepage}` : "",
    repo ? `Repository: ${repo.replace(/^git\+/, "").replace(/\.git$/, "")}` : "",
    "",
    "## README",
    "",
    data.readme || "_(no README in registry metadata)_",
  ].join("\n");
  return [{ ...capped(md), name: `${name.replace(/[@/]/g, "_")}-npm.md` }];
}

async function fetchPypi(name: string): Promise<FetchedFile[]> {
  const data = await getJson<any>(`https://pypi.org/pypi/${name}/json`);
  if (!data?.info) return [];
  const info = data.info;
  const md = [
    `# PyPI: ${info.name}${info.version ? ` ${info.version}` : ""}`,
    "",
    `<${info.package_url || `https://pypi.org/project/${name}/`}>`,
    "",
    info.summary || "",
    info.home_page ? `\nHomepage: ${info.home_page}` : "",
    "",
    "## Description",
    "",
    info.description || "_(no description)_",
  ].join("\n");
  return [{ ...capped(md), name: `${name}-pypi.md` }];
}

/** Fetch and extract a document while retaining its actual destination and quality. */
async function fetchWeb(url: string): Promise<FetchedFile[]> {
  const r = await httpGet(url, "text/html,text/plain;q=0.9,*/*;q=0.1");
  if (!r) return [];
  if (/^(image|video|audio|application\/(zip|pdf|octet))/i.test(r.contentType)) {
    throw new Error("non-text page; article not captured");
  }
  const raw = r.buf.toString("utf8");
  const isHtml = /html/i.test(r.contentType) || /<html[\s>]/i.test(raw.slice(0, 1000));
  let text: string;
  const metadata: SourceMetadata = { finalUrl: r.finalUrl, extractionMethod: "plain-text", extractionVersion: WEB_EXTRACTION_VERSION };
  let inputTruncated = r.truncated;
  if (isHtml) {
    const document = extractWebDocument(raw, r.finalUrl);
    text = document.text;
    Object.assign(metadata, { title: document.title, canonicalUrl: document.canonicalUrl,
      extractionMethod: document.extractionMethod, warning: document.warning, images: document.images, videoUrls: document.videoUrls, videos: document.videos, imageDiscoveryVersion: document.imageDiscoveryVersion });
    inputTruncated ||= document.truncated;
  } else {
    text = raw;
    if (text.trim().length < 300) throw new Error("no readable article content");
  }
  const out = capped(text);
  const truncated = out.truncated || inputTruncated;
  metadata.textStatus = metadata.warning || truncated ? "partial" : "complete";
  const host = new URL(r.finalUrl).hostname.replace(/^www\./, "");
  return [{ name: `${host}.md`, text: out.text, truncated, metadata }];
}

/** Prefer a full paper over an abstract, but label a usable abstract fallback. */
async function fetchArxiv(id: string): Promise<FetchedFile[]> {
  const fullUrl = `https://arxiv.org/html/${id}`;
  let reason = "Full HTML paper was unavailable";
  try {
    const full = await fetchWeb(fullUrl);
    if (full.length && !full.some((file) => /\/abs\//.test(file.metadata?.finalUrl ?? ""))) {
      for (const file of full) file.metadata = { ...file.metadata, resolution: "full-text", attemptedUrl: fullUrl };
      return full;
    }
  } catch (error) { reason += ` (${(error as Error).message})`; }
  const fallback = await fetchWeb(`https://arxiv.org/abs/${id}`);
  for (const file of fallback) {
    file.metadata = { ...file.metadata, resolution: "abstract-only", attemptedUrl: fullUrl,
      warning: `${reason}; saved abstract only. ${file.metadata?.warning ?? ""}`.trim() };
  }
  return fallback;
}

// ── classification ─────────────────────────────────────────────────────────

function validWebHostname(raw: string): boolean {
  const hostname = raw.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return !!isIP(hostname) || (hostname.length <= 253 && hostname.split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)));
}

/** Only discard an obsolete failed discovery, never a historical source file. */
function obsoleteInvalidReference(ref: LinkedReference): boolean {
  if (ref.files.length) return false;
  try {
    const url = new URL(ref.url);
    if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "vimeo.com", "player.vimeo.com"].includes(url.hostname) && !hostedVideoUrl(ref.url)) return true;
    return !validWebHostname(url.hostname);
  }
  catch { return false; } // Not enough evidence to classify a malformed URL's host.
}

/** Map a URL to a fetch plan, or null if we don't follow it. */
export function planLink(rawInput: string): Plan | null {
  let u: URL;
  try {
    u = new URL(rawInput);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // URL accepts apostrophes and other punctuation in a hostname even though
  // they are not valid DNS names (e.g. prose-derived "http://CLAUDE.md's").
  if (!validWebHostname(u.hostname)) return null;
  if (/^(?:www\.)?arxiv\.org$/i.test(u.hostname)) {
    const paper = u.pathname.match(/^\/(?:abs|pdf)\/([a-z-]+\/\d{7}(?:v\d+)?|\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?$/i);
    if (paper) return { kind: "web", title: `arXiv ${paper[1]}`, fetch: () => fetchArxiv(paper[1]) };
  }
  // Apply to specialized hosts too: GitHub image blobs are media, not text.
  if (MEDIA_EXT.test(u.pathname)) return null;
  const host = u.hostname.replace(/^www\./, "").replace(/\.$/, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];

  // github.com/<owner>/<repo>/blob|raw/<ref>/<path...>
  if (host === "github.com" && (parts[2] === "blob" || parts[2] === "raw") && parts.length >= 5) {
    const [owner, repo, , ref, ...rest] = parts;
    const filePath = rest.join("/");
    return {
      kind: "github-file",
      title: `${owner}/${repo}: ${filePath}`,
      fetch: () => fetchGithubFile(owner, repo, ref, filePath, last || `${repo}.txt`),
    };
  }
  if (host === "raw.githubusercontent.com" && parts.length >= 4) {
    const [owner, repo, ref, ...rest] = parts;
    const filePath = rest.join("/");
    return {
      kind: "github-file",
      title: `${owner}/${repo}: ${filePath}`,
      fetch: () => fetchGithubFile(owner, repo, ref, filePath, last || "file.txt"),
    };
  }
  // github.com/<owner>/<repo>/tree/<ref>/<directory> — subtree README.
  if (host === "github.com" && parts[2] === "tree" && parts.length >= 4) {
    const [owner, repo, , ref, ...directory] = parts;
    return { kind: "github-repo", title: `${owner}/${repo}/${directory.join("/")} README`,
      fetch: () => fetchDirectoryReadme(owner, repo, ref, directory.join("/")) };
  }
  // github.com/<owner>/<repo> — README
  if (host === "github.com" && parts.length === 2) {
    const [owner, repo] = parts;
    return {
      kind: "github-repo",
      title: `${owner}/${repo} README`,
      fetch: () => fetchRepoReadme(owner, repo, `${repo}-README.md`),
    };
  }
  // gist.github.com/<user>/<id>
  if (host === "gist.github.com" && parts.length >= 2 && /^[0-9a-f]+$/i.test(parts[1])) {
    const [user, id] = parts;
    return { kind: "gist", title: `gist ${user}/${id}`, fetch: () => fetchGist(user, id) };
  }
  // npmjs.com/package/<name> (incl. @scope/name)
  if (host === "npmjs.com" && parts[0] === "package" && parts.length >= 2) {
    const name = parts.slice(1).join("/");
    return { kind: "npm", title: `npm: ${name}`, fetch: () => fetchNpm(name) };
  }
  // pypi.org/project/<name>
  if (host === "pypi.org" && parts[0] === "project" && parts.length >= 2) {
    const name = parts[1];
    return { kind: "pypi", title: `PyPI: ${name}`, fetch: () => fetchPypi(name) };
  }

  if (["youtube.com", "m.youtube.com", "youtu.be", "vimeo.com"].includes(host)) {
    if (!hostedVideoUrl(u.toString())) return null;
    return { kind: "video", title: host + u.pathname, video: true, fetch: async () => [] };
  }
  // Generic web page — skip social/self/media.
  if (SKIP_HOSTS.has(host) || MEDIA_EXT.test(u.pathname)) return null;
  return { kind: "web", title: host + u.pathname, fetch: () => fetchWeb(u.toString()) };
}

// ── orchestration ──────────────────────────────────────────────────────────

type Provenance = NonNullable<LinkedReference["provenance"]>;

function payloadSources(thread: Thread): Map<string, { tweet: TweetNode; provenance: Provenance }> {
  const sources = new Map<string, { tweet: TweetNode; provenance: Provenance }>();
  const visited = new Set<Thread>();
  const include = (tweet: TweetNode, provenance: Provenance): void => {
    if (sources.has(tweet.id)) return;
    sources.set(tweet.id, { tweet, provenance });
    if (tweet.quoted) include(tweet.quoted, "quoted");
    for (const embedded of tweet.embeddedTweets ?? []) include(embedded, "embedded");
  };
  const visit = (current: Thread): void => {
    if (visited.has(current)) return;
    visited.add(current);
    const author = current.main.author.handle.toLowerCase();
    for (const tweet of [current.main, ...current.ancestors, ...current.replies]) {
      if (tweet.author.handle.toLowerCase() === author) include(tweet, "author");
    }
    for (const linked of current.linkedTweets ?? []) if (linked.thread) visit(linked.thread);
  };
  visit(thread);
  return sources;
}

/** Author payload, including attached sources and bounded linked-tweet captures. */
export function payloadTweets(thread: Thread): TweetNode[] {
  return [...payloadSources(thread).values()].map(({ tweet }) => tweet);
}

export function collectLinks(
  thread: Thread,
  allLinks: boolean,
): { url: string; plan: Plan; tweet: TweetNode; provenance: Provenance }[] {
  const out: { url: string; plan: Plan; tweet: TweetNode; provenance: Provenance }[] = [];
  const seen = new Set<string>();
  const sources = payloadSources(thread);
  // Prioritize substantive author sources. Reply-linked packages and repositories
  // remain available, explicitly labeled as supplemental instead of main payload.
  const tweets = [...payloadTweets(thread), ...allTweets(thread).filter((tweet) => !sources.has(tweet.id))];
  for (const tweet of tweets) {
    const provenance = sources.get(tweet.id)?.provenance ?? "reply";
    for (const url of urlsIn(tweet.text)) {
      const plan = planLink(url);
      if (!plan) continue;
      if (plan.kind === "web" && provenance === "reply" && !allLinks) continue;
      const key = dedupKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url, plan, tweet, provenance });
    }
  }
  return out;
}

function uniqueName(name: string, used: Set<string>): string {
  let safe = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  // "" / "." / ".." are not usable filenames (the last two are dir refs).
  if (safe === "" || /^\.+$/.test(safe)) safe = "file.txt";
  if (!used.has(safe)) {
    used.add(safe);
    return safe;
  }
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  let i = 2;
  let candidate = `${stem}-${i}${ext}`;
  while (used.has(candidate)) candidate = `${stem}-${++i}${ext}`;
  used.add(candidate);
  return candidate;
}

export interface LinkOptions {
  onStatus?: (message: string) => void;
  concurrency?: number;
  /** Follow generic web links from every poster, not just the original author. */
  allLinks?: boolean;
  /** Keep successful files and retry only failed/partial reference fetches. */
  resume?: boolean;
}

/** A file's presence alone cannot establish article extraction quality. */
export function webReferenceNeedsUpgrade(ref: LinkedReference): boolean {
  if (ref.kind !== "web" || ref.status === "skipped") return false;
  if (["semantic", "readability", "body"].includes(ref.extractionMethod ?? "") && !ref.imageDiscoveryVersion) return true;
  if (ref.extractionVersion !== WEB_EXTRACTION_VERSION || !ref.extractionMethod || ref.extractionMethod === "source" || !ref.finalUrl || !ref.status) return true;
  try {
    const source = new URL(ref.url);
    if (/^(?:www\.)?arxiv\.org$/i.test(source.hostname) && /^\/(?:abs|pdf)\//.test(source.pathname)) {
      const final = new URL(ref.finalUrl);
      return ref.resolution !== "full-text" || !/^(?:www\.)?arxiv\.org$/i.test(final.hostname) || !final.pathname.startsWith("/html/");
    }
  } catch { return true; }
  return false;
}

/**
 * Fetch every followable link in the thread, save the content under
 * `<outDir>/refs/`, and attach the results to `thread.references`.
 */
function repositoryReferenceNeedsUpgrade(ref: LinkedReference): boolean {
  return ["github-file", "github-repo", "gist"].includes(ref.kind)
    && (ref.extractionVersion !== REPOSITORY_DOCUMENT_VERSION || ref.imageDiscoveryVersion !== REPOSITORY_IMAGE_VERSION);
}

export async function fetchReferences(
  thread: Thread,
  outDir: string,
  opts: LinkOptions = {},
): Promise<void> {
  const status = opts.onStatus ?? (() => {});
  const links = collectLinks(thread, opts.allLinks ?? false);
  const previous = opts.resume ? (thread.references ?? []).filter((ref) => !obsoleteInvalidReference(ref)).map((ref): LinkedReference => {
    if (!webReferenceNeedsUpgrade(ref) || (ref.extractionVersion === WEB_EXTRACTION_VERSION && ref.resolution === "abstract-only")) return ref;
    const unknown = "Legacy or incomplete web extraction metadata: article completeness is unknown until re-extracted.";
    return { ...ref, status: ref.files.length ? "partial" : "failed", resolution: "unknown",
      warning: ref.warning?.includes(unknown) ? ref.warning : `${unknown} ${ref.warning ?? ""}`.trim() };
  }) : [];
  if (links.length === 0 && previous.length === 0) {
    if (opts.resume) thread.references = [];
    return;
  }

  const refsDir = path.join(outDir, "refs");
  if (!opts.resume) await fs.rm(refsDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(refsDir, { recursive: true });
  const usedNames = new Set(previous.flatMap((ref) => ref.files.map((file) => path.basename(file.localPath))));
  const canReuse = async (ref: LinkedReference): Promise<boolean> => {
    const textComplete = ["web", "github-file", "github-repo", "gist"].includes(ref.kind) && ref.textStatus === "complete" && !ref.extractionWarning;
    if (webReferenceNeedsUpgrade(ref) || repositoryReferenceNeedsUpgrade(ref) || !ref.files.length || ref.error || (!textComplete && ((ref.kind === "web" && ref.status !== "complete") || ref.warning || ref.status === "partial" || ref.status === "failed")) || ref.files.some((file) => file.truncated)) return false;
    for (const file of ref.files) {
      const absolute = path.resolve(outDir, file.localPath);
      if (!absolute.startsWith(path.resolve(outDir) + path.sep)) return false;
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat?.isFile() || stat.size !== file.bytes) return false;
      if (file.sourcePath) {
        const source = path.resolve(outDir, file.sourcePath);
        if (!source.startsWith(path.resolve(outDir) + path.sep) || !(await fs.stat(source).then((st) => st.isFile() && st.size > 0).catch(() => false))) return false;
      }
    }
    return true;
  };
  const linkedKeys = new Set(links.map((link) => dedupKey(link.url)));
  for (const prior of previous) {
    if (linkedKeys.has(dedupKey(prior.url)) || prior.status === "skipped" || await canReuse(prior)) continue;
    const plan = planLink(prior.url);
    if (!plan) continue;
    const tweet = allTweets(thread).find((tweet) => tweet.id === prior.sourceTweetId) ?? thread.main;
    links.push({ url: prior.url, plan, tweet, provenance: prior.provenance ?? "author" });
    linkedKeys.add(dedupKey(prior.url));
  }
  const references: LinkedReference[] = new Array(links.length);
  let done = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < links.length) {
      const idx = cursor++;
      const { url, plan, tweet, provenance } = links[idx];
      const prior = previous.find((ref) => dedupKey(ref.url) === dedupKey(url));
      if (prior && await canReuse(prior)) {
        references[idx] = { ...prior, provenance: prior.provenance ?? provenance };
        done++;
        status(`Reusing linked source ${done}/${links.length}…`);
        continue;
      }
      const ref: LinkedReference = {
        url, kind: plan.kind, sourceTweetId: tweet.id, title: plan.title,
        files: [], provenance, fetchedAt: new Date().toISOString(),
        extractionMethod: plan.kind === "web" ? undefined : "source",
      };
      try {
        if (plan.video) {
          Object.assign(ref, prior, {kind: "video", url, provenance});
          ref.status = "partial";
          delete ref.error;
          ref.warning = "Video transcript pending or unavailable.";
        } else if (plan.skipReason) {
          ref.status = "skipped";
          ref.warning = plan.skipReason;
        } else {
          const fetched = await plan.fetch();
          for (const f of fetched) {
            if (!f.text.trim()) continue;
            const filename = uniqueName(f.name, usedNames);
            await fs.writeFile(path.join(refsDir, filename), f.text, "utf8");
            if (f.metadata) {
              const { images, videoUrls, videos, warning, textStatus, ...metadata } = f.metadata;
              const warnings = [ref.extractionWarning, warning].filter((value): value is string => !!value);
              const textStates = [ref.textStatus, textStatus];
              Object.assign(ref, metadata);
              ref.extractionWarning = [...new Set(warnings)].join(" ") || undefined;
              ref.warning = ref.extractionWarning;
              ref.textStatus = textStates.includes("failed") ? "failed" : textStates.includes("partial") ? "partial" : textStates.includes("complete") ? "complete" : undefined;
              if (images) {
                const priorImages = new Map((prior?.media ?? []).map((media) => [canonicalReferenceImageUrl(media.url), media]));
                const union = new Map((ref.media ?? []).map((media) => [canonicalReferenceImageUrl(media.url), media]));
                for (const image of images) {
                  const key = canonicalReferenceImageUrl(image.url);
                  union.set(key, { ...priorImages.get(key), ...union.get(key), ...image, type: "photo" as const });
                }
                ref.media = [...union.values()];
              }
              if (videos || videoUrls) {
                const union = new Map((ref.videos ?? []).map((video) => [video.url, video]));
                for (const video of videos ?? videoUrls!.map((url) => ({ url }))) union.set(video.url, { ...prior?.videos?.find((old) => old.url === video.url), ...union.get(video.url), ...video });
                ref.videos = [...union.values()];
              }
            }
            ref.files.push({
              localPath: path.join("refs", filename), bytes: Buffer.byteLength(f.text, "utf8"),
              truncated: f.truncated || undefined,
              finalUrl: f.metadata?.finalUrl, extractionMethod: f.metadata?.extractionMethod,
              extractionVersion: f.metadata?.extractionVersion, warning: f.metadata?.warning,
            });
          }
          if (!ref.files.length) ref.error = "fetch failed; source content not captured";
          ref.status = ref.error ? "failed" : ref.warning || ref.files.some((file) => file.truncated) ? "partial" : "complete";
        }
      } catch (e) {
        ref.error = (e as Error).message || "fetch failed";
        ref.status = "failed";
      }
      // A failed retry must not erase a useful preview or earlier source copy.
      if (ref.status === "failed" && prior?.files.length) {
        Object.assign(ref, { ...prior, ...ref, title: prior.title, files: prior.files });
        ref.status = "partial";
        const retryNotice = "Retry failed; retained previous source copy.";
        let priorWarning = (prior.extractionWarning ?? prior.warning ?? "").replaceAll(retryNotice, "");
        // Runtime errors are reported separately by reference coverage. Do not
        // fold yesterday's error back into the immutable extraction warning.
        for (const error of [prior.error, ref.error]) if (error) priorWarning = priorWarning.replaceAll(error, "");
        ref.extractionWarning = `${retryNotice} ${priorWarning.replace(/\s+/g, " ").trim()}`.trim();
        ref.warning = ref.extractionWarning;
      }
      references[idx] = ref;
      done++;
      status(`Fetching linked sources ${done}/${links.length}…`);
    }
  };
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, links.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
  // Keep supplementary sources added by a previous run (for example a full
  // paper manually resolved from an abstract) even if not literal tweet links.
  const keys = new Set(references.map((ref) => dedupKey(ref.url)));
  thread.references = [...references, ...previous.filter((ref) => !keys.has(dedupKey(ref.url)))];
}
