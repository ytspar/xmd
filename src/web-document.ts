/** Article extraction without executing page scripts or loading remote resources. */
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { youtubeVideoId, type CaptionTrack } from "./transcripts.js";
import { canonicalReferenceImageUrl, referenceImageKey, WEB_IMAGE_DISCOVERY_VERSION, type DiscoveredReferenceImage } from "./reference-images.js";
export { WEB_IMAGE_DISCOVERY_VERSION } from "./reference-images.js";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
/** Bump when extraction or quality rules change; legacy files require upgrade. */
export const WEB_EXTRACTION_VERSION = "article-markdown-v3";
export interface WebDocument {
  text: string;
  title: string;
  canonicalUrl?: string;
  extractionMethod: "readability" | "semantic" | "body";
  warning?: string;
  truncated: boolean;
  imageUrls: string[];
  images: DiscoveredReferenceImage[];
  imageDiscoveryVersion: string;
  videoUrls: string[];
  videos: { url: string; captionTracks?: CaptionTrack[] }[];
}

function httpUrl(value: string | null, base: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) ? url.toString() : undefined;
  } catch { return undefined; }
}

function imageUrl(value: string | null, base: string): string | undefined {
  if (value?.startsWith("data:image/")) return value;
  return httpUrl(value, base);
}

/** Prefer the largest advertised responsive resource, not a lazy placeholder. */
export function responsiveImage(image: Element, base: string, resolve = imageUrl): string | undefined {
  const candidates: { url: string; score: number; unit: string }[] = [];
  const picture = image.closest("picture");
  const sets = [image.getAttribute("data-srcset"), image.getAttribute("srcset"),
    ...[...(picture?.querySelectorAll("source") ?? [])].flatMap((source) => [source.getAttribute("data-srcset"), source.getAttribute("srcset")])];
  for (const set of sets) {
    if (!set) continue;
    // URLs can contain commas (notably Cloudinary transformation paths). A
    // candidate URL ends at whitespace; commas delimit its descriptor list.
    let position = 0;
    while (position < set.length) {
      while (/[\s,]/.test(set[position] ?? "") && position < set.length) position++;
      const start = position;
      while (position < set.length && !/\s/.test(set[position])) position++;
      let target = set.slice(start, position);
      let descriptor = "";
      if (target.endsWith(",")) target = target.replace(/,+$/, "");
      else {
        const descriptorStart = position;
        while (position < set.length && set[position] !== ",") position++;
        descriptor = set.slice(descriptorStart, position).trim();
        if (set[position] === ",") position++;
      }
      if (!target) continue;
      const match = descriptor.match(/^([\d.]+)(w|x)$/);
      if (descriptor && !match) continue;
      const absolute = resolve(target, base);
      if (absolute) candidates.push({ url: absolute, score: Number(match?.[1] ?? 1), unit: match?.[2] ?? "x" });
    }
  }
  const widths = candidates.filter((candidate) => candidate.unit === "w");
  const responsive = (widths.length ? widths : candidates).sort((a, b) => b.score - a.score)[0];
  if (responsive) return responsive.url;
  for (const attr of ["data-original", "data-src", "data-lazy-src", "data-url", "src"]) {
    const value = resolve(image.getAttribute(attr), base);
    if (value) return value;
  }
  return undefined;
}

function knownTinyIcon(image: Element, caption: string | undefined): boolean {
  const width = image.getAttribute("width") ?? "";
  const height = image.getAttribute("height") ?? "";
  const alt = image.getAttribute("alt") ?? image.getAttribute("aria-label") ?? image.querySelector("title")?.textContent ?? "";
  return /^\d+(?:px)?$/.test(width) && /^\d+(?:px)?$/.test(height)
    && parseInt(width) <= 32 && parseInt(height) <= 32 && !caption
    && (!alt.trim() || /(?:logo|icon|avatar|emoji|pixel|spacer)/i.test(alt));
}

/** Only actual hosted videos are transcript targets; channel links are not. */
export function hostedVideoUrl(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return undefined;
    const youtube = youtubeVideoId(input);
    const host = url.hostname.replace(/^www\./, "");
    const videoPath = host === "youtu.be" ? /^\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)
      : url.pathname === "/watch" || /^\/(?:embed|shorts|live)\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname);
    if (youtube && videoPath && !["videoseries", "live_stream"].includes(youtube)) return `https://www.youtube.com/watch?v=${youtube}`;
    if (["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(url.hostname)) {
      const id = url.pathname.match(/^\/(?:video\/)?(\d+)\/?$/)?.[1];
      if (id) return `https://vimeo.com/${id}`;
    }
  } catch { /* Not a supported hosted video URL. */ }
  return undefined;
}

/** Exported for deterministic fixture checks; never fetches or executes HTML. */
export function extractWebDocument(rawHtml: string, url: string): WebDocument {
  const bytes = Buffer.from(rawHtml, "utf8");
  const truncated = bytes.byteLength > MAX_HTML_BYTES;
  const html = truncated ? bytes.subarray(0, MAX_HTML_BYTES).toString("utf8") : rawHtml;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error & { type?: string }) => {
    // Modern publisher CSS is often beyond JSDOM's CSS parser. Styles are
    // removed below and irrelevant to text extraction; do not dump stylesheets.
    if (/^css[ -]parsing$/i.test(error.type ?? "")) return;
    console.error(`Document parser diagnostic: ${error.message}`);
  });
  const dom = new JSDOM(html, { url, virtualConsole });
  try {
    const doc = dom.window.document;
    const title = doc.querySelector("meta[property='og:title']")?.getAttribute("content")?.trim()
      || doc.title.trim() || doc.querySelector("h1")?.textContent?.trim() || new URL(url).hostname;
    const canonicalUrl = httpUrl(doc.querySelector("link[rel~='canonical']")?.getAttribute("href") ?? null, url);
    const heading = doc.querySelector("h1")?.textContent ?? "";
    if (/^(?:just a moment|attention required|access denied|403 forbidden|sign in|log in|verify (?:you|your)|security (?:check|verification)|robot check|enable javascript)/i.test(`${title}\n${heading}`.trim())
      || doc.querySelector("#challenge-running, #cf-challenge-running, form#challenge-form, .g-recaptcha, [data-captcha]")) {
      throw new Error("blocked, login, or challenge page; article not captured");
    }
    const paywall = !!doc.querySelector("[class*='paywall'], [id*='paywall'], [data-paywall]")
      || /"isAccessibleForFree"\s*:\s*(?:false|"false")/.test(html);
    const sourceContainer = [...doc.querySelectorAll("article, main, [role='main']")]
      .sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0))[0] ?? doc.body;
    const videos = new Map<string, { url: string; captionTracks?: CaptionTrack[] }>();
    let unresolvedVideos = 0;
    const addVideo = (target: string, tracks: CaptionTrack[] = []): void => {
      const prior = videos.get(target);
      const unique = new Map((prior?.captionTracks ?? []).map((track) => [track.url, track]));
      tracks.forEach((track) => unique.set(track.url, track));
      videos.set(target, { url: target, captionTracks: unique.size ? [...unique.values()] : undefined });
    };
    for (const anchor of sourceContainer.querySelectorAll("a[href]")) {
      const target = httpUrl(anchor.getAttribute("href"), url);
      const video = target ? hostedVideoUrl(target) : undefined;
      if (video) addVideo(video);
    }
    for (const embedded of sourceContainer.querySelectorAll("iframe, video")) {
      const replacement = doc.createElement("div");
      let target: string | undefined;
      let tracks: CaptionTrack[] = [];
      if (embedded.localName === "iframe") {
        const source = httpUrl(embedded.getAttribute("src") ?? embedded.getAttribute("data-src"), url);
        target = source ? hostedVideoUrl(source) : undefined;
      } else {
        const sources = [embedded.getAttribute("src"), ...[...embedded.querySelectorAll("source[src]")].map((node) => node.getAttribute("src"))];
        target = sources.map((source) => httpUrl(source, url)).find(Boolean);
        if (target) target = hostedVideoUrl(target) ?? target;
        tracks = [...embedded.querySelectorAll("track[src]")].flatMap((node): CaptionTrack[] => {
          const kind = node.getAttribute("kind")?.toLowerCase();
          if (kind && !["captions", "subtitles"].includes(kind)) return [];
          const trackUrl = httpUrl(node.getAttribute("src"), url);
          if (!trackUrl) return [];
          const extension = new URL(trackUrl).pathname.match(/\.(vtt|srt|ttml|xml|json3)$/i)?.[1]?.toLowerCase();
          return [{ url: trackUrl, language: node.getAttribute("srclang") || undefined,
            automatic: node.getAttribute("data-automatic") === "true" || undefined, format: extension }];
        });
        if (!target) unresolvedVideos++;
      }
      if (target) {
        addVideo(target, tracks);
        const anchor = doc.createElement("a"); anchor.href = target; anchor.textContent = `Video: ${target}`;
        replacement.append(anchor, doc.createElement("br"));
      }
      for (const track of tracks) {
        const anchor = doc.createElement("a"); anchor.href = track.url;
        anchor.textContent = `Captions${track.language ? ` (${track.language})` : ""}: ${track.url}`;
        replacement.append(anchor, doc.createElement("br"));
      }
      embedded.replaceWith(replacement);
    }
    // Remove navigation before both semantic fallback and the readability pass.
    doc.querySelectorAll("script, style, noscript, iframe, object, embed, nav, footer, form, aside, [hidden], [aria-hidden='true']")
      .forEach((element) => {
        // Internal SVG styles are part of the figure, not page chrome. The
        // rasterizer separately rejects external/active SVG resources.
        if (element.localName === "style" && element.closest("svg")) return;
        element.remove();
      });
    for (const element of doc.querySelectorAll("*")) {
      for (const attribute of [...element.attributes]) {
        if (/^on/i.test(attribute.name) || attribute.name === "srcdoc"
          || (attribute.name === "style" && element.namespaceURI !== "http://www.w3.org/2000/svg")) element.removeAttribute(attribute.name);
      }
    }
    for (const anchor of doc.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href");
      if (href?.startsWith("#")) continue;
      const absolute = httpUrl(href, url);
      if (absolute) anchor.setAttribute("href", absolute);
      else anchor.removeAttribute("href");
    }
    for (const svg of doc.querySelectorAll("svg")) {
      const caption = svg.closest("figure")?.querySelector("figcaption")?.textContent?.trim();
      const alt = svg.getAttribute("aria-label") ?? svg.querySelector("title")?.textContent ?? "";
      if (knownTinyIcon(svg, caption)) { svg.remove(); continue; }
      if (!svg.hasAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const image = doc.createElement("img");
      image.setAttribute("src", `data:image/svg+xml;base64,${Buffer.from(svg.outerHTML).toString("base64")}`);
      if (alt) image.setAttribute("alt", alt);
      svg.replaceWith(image);
    }
    for (const image of doc.querySelectorAll("img")) {
      const caption = image.closest("figure")?.querySelector("figcaption")?.textContent?.trim();
      const absolute = responsiveImage(image, url);
      if (!absolute || knownTinyIcon(image, caption)) image.remove();
      else image.setAttribute("src", absolute);
    }
    const semantic = [...doc.querySelectorAll("article, main, [role='main']")]
      .sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0))[0];
    const readable = new Readability(doc.cloneNode(true) as Document, { keepClasses: false }).parse();
    let content: string;
    let extractionMethod: WebDocument["extractionMethod"];
    // An explicit article/main is the least lossy source: Readability may drop
    // code or one-cell tables it considers presentational. Use its scored
    // extraction when the publisher provides no usable semantic container.
    if (semantic && (semantic.textContent?.trim().length ?? 0) >= 300) {
      content = semantic.innerHTML;
      extractionMethod = "semantic";
    } else if (readable?.content && (readable.textContent?.trim().length ?? 0) >= 300) {
      content = readable.content;
      extractionMethod = "readability";
    } else {
      content = doc.body.innerHTML;
      extractionMethod = "body";
    }
    const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
    converter.use(gfm);
    // GFM cannot express merged cells or headerless tables faithfully. Retain
    // those as HTML, which Markdown supports, rather than flattening their cells.
    converter.addRule("complexTables", {
      filter: (node) => node.nodeName === "TABLE" &&
        (!node.querySelector("th") || !!node.querySelector("[colspan], [rowspan]")),
      replacement: (_content, node) => `\n\n${(node as HTMLElement).outerHTML}\n\n`,
    });
    const container = doc.createElement("div");
    container.innerHTML = content;
    const imageMap = new Map<string, DiscoveredReferenceImage>();
    for (const image of container.querySelectorAll("img[src]")) {
      const target = canonicalReferenceImageUrl(image.getAttribute("src")!);
      image.setAttribute("src", target);
      const caption = image.closest("figure")?.querySelector("figcaption")?.textContent?.trim();
      const altText = image.getAttribute("alt")?.trim() || undefined;
      const prior = imageMap.get(target);
      if (prior) { prior.altText ||= altText; prior.caption ||= caption; }
      else imageMap.set(target, { url: target, altText, caption });
    }
    const images = [...imageMap.values()];
    const imageUrls = images.map((image) => image.url);
    converter.addRule("referenceImagePlacement", {
      filter: "img",
      replacement: (_content, node) => {
        const target = node.getAttribute("src");
        return target ? `\n\n[[reference-image:${referenceImageKey(target)}]]\n\n` : "";
      },
    });
    const body = converter.turndown(content).trim();
    if (body.replace(/\s+/g, " ").length < 300) throw new Error("blocked or no readable article content");
    const warnings = [
      extractionMethod === "body" ? "Article body could not be isolated; page-body fallback may include unrelated content." : "",
      paywall ? "Possible paywall: extracted text may be a preview rather than the full article." : "",
      truncated ? "HTML input exceeded the extraction limit." : "",
      unresolvedVideos ? `${unresolvedVideos} embedded video(s) had no resolvable media source; transcript capture is incomplete.` : "",

    ].filter(Boolean);
    return {
      title, canonicalUrl, extractionMethod, truncated, imageUrls, images, imageDiscoveryVersion: WEB_IMAGE_DISCOVERY_VERSION, videoUrls: [...videos.keys()], videos: [...videos.values()],
      warning: warnings.join(" ") || undefined,
      text: [`# ${title}`, `<${url}>`, body].join("\n\n"),
    };
  } finally { dom.window.close(); }
}
