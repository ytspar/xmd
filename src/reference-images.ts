/** Bounded, resumable source-article image capture, independent of tweet media. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { JSDOM } from "jsdom";
import { tmpdir } from "node:os";
import { renderAsync } from "@resvg/resvg-js";
import { inlineSvgStyles } from "./svg-styles.js";
import { svgFontToSfnt, svgFontFamilyNames, verifySvgFontRendering } from "./svg-fonts.js";
import type { LinkedReference, MediaItem } from "./types.js";

export const WEB_IMAGE_DISCOVERY_VERSION = "article-images-v1";
export const REFERENCE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const REFERENCE_IMAGE_MAX_COUNT = 64;
const MAX_PIXELS = 32 * 1024 * 1024;
const MAX_DIMENSION = 16_384;

export interface DiscoveredReferenceImage { url: string; altText?: string; caption?: string }
export interface ReferenceImageOptions {
  images?: DiscoveredReferenceImage[];
  resume?: boolean;
  maxImages?: number;
  onStatus?: (message: string) => void;
}

/** Preserve transformation query parameters; collapse only URL identity trivia. */
export function canonicalReferenceImageUrl(input: string): string {
  if (input.startsWith("data:image/")) return input;
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Unsupported article image URL protocol");
  url.hash = "";
  return url.toString();
}

export function referenceImageKey(url: string): string {
  return createHash("sha256").update(canonicalReferenceImageUrl(url)).digest("hex");
}

function localCssResources(value: string): boolean {
  if (/\\/.test(value)) return false;
  const urls = [...value.matchAll(/url\s*\(\s*(["']?)(.*?)\1\s*\)/gi)];
  return urls.every((match) => match[2].trim().startsWith("#"))
    && value.replace(/url\s*\(\s*(["']?)(.*?)\1\s*\)/gi, "").search(/url\s*\(/i) === -1;
}

interface SvgContext {baseUrl?:string;deadline:number;background?:string;fonts:Buffer[];resources:{url:string;bytes:number;kind:"stylesheet"|"font"}[]}
/** Resolve approved styling first; the rasterizer receives no network URLs. */
async function safeSvg(input: Buffer, budget = {bytes: REFERENCE_IMAGE_MAX_BYTES}, depth = 0, context:SvgContext = {deadline:Date.now()+20_000,fonts:[],resources:[]}): Promise<Buffer> {
  if(depth>3 || input.length>budget.bytes)throw new Error("Embedded SVG image exceeds nesting/byte limit");
  budget.bytes-=input.length;
  const text = input.toString("utf8");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error("Unsafe SVG entity/doctype declaration");
  const dom = new JSDOM(text, { contentType: "image/svg+xml" });
  try {
    const doc = dom.window.document;
    if (doc.documentElement.localName !== "svg") throw new Error("Invalid SVG root");
    if (doc.querySelector("script, foreignObject, iframe, object, embed")) {
      throw new Error("Unsafe SVG active or external-image element");
    }
    const styles=await inlineSvgStyles(doc,context.baseUrl,{deadline:context.deadline});
    if(depth===0)context.background=(doc.documentElement as unknown as SVGElement).style?.backgroundColor || undefined;
    context.fonts.push(...styles.fonts);context.resources.push(...styles.resources);
    if(context.fonts.length>8||context.fonts.reduce((n,font)=>n+font.length,0)>4*1024*1024)throw new Error("SVG font count/byte limit exceeded");
    if(context.resources.filter(resource=>resource.kind==="stylesheet").length>4||context.resources.reduce((n,resource)=>n+resource.bytes,0)>4*1024*1024)throw new Error("SVG style resource count/byte limit exceeded");
    for (const element of doc.querySelectorAll("*")) {
      for (const attribute of [...element.attributes]) {
        if (/^on/i.test(attribute.name)) throw new Error("Unsafe SVG event handler");
        if (/(?:^|:)href$/i.test(attribute.name) && !attribute.value.trim().startsWith("#")) {
          // Shields badges often embed their logo as a self-contained SVG.
          // Validate nested bytes; never let the rasterizer fetch a resource.
          const value=attribute.value.trim();
          const embedded=value.match(/^data:image\/(svg\+xml|png|jpeg|webp|gif)(;base64)?,([^]*)$/i);
          if(!["image","feImage"].includes(element.localName)||!embedded)throw new Error("Unsafe SVG external resource reference");
          if(embedded[3].length>REFERENCE_IMAGE_MAX_BYTES*2)throw new Error("Embedded SVG image exceeds byte limit");
          const bytes=embedded[2]?Buffer.from(embedded[3],"base64"):Buffer.from(decodeURIComponent(embedded[3]));
          if(embedded[1].toLowerCase()==="svg+xml"){
            const safe=await safeSvg(bytes,budget,depth+1,context);
            attribute.value=`data:image/svg+xml;base64,${safe.toString("base64")}`;
          }else{
            if(bytes.length>budget.bytes)throw new Error("Embedded SVG image exceeds byte limit");
            budget.bytes-=bytes.length;
            const image=sharp(bytes,{limitInputPixels:MAX_PIXELS,failOn:"warning"});
            const meta=await image.metadata();
            if(!meta.width||!meta.height||meta.width>MAX_DIMENSION||meta.height>MAX_DIMENSION||meta.width*meta.height>MAX_PIXELS||meta.format==="svg")throw new Error("Embedded SVG image exceeds pixel/format limit");
            const png=await image.timeout({seconds:15}).png().toBuffer();
            if(png.length>budget.bytes)throw new Error("Embedded SVG image exceeds raster byte limit");
            budget.bytes-=png.length;
            attribute.value=`data:image/png;base64,${png.toString("base64")}`;
          }
        }
        if (/url\s*\(/i.test(attribute.value) && !localCssResources(attribute.value)) {
          throw new Error("Unsafe SVG external CSS resource");
        }
      }
      if (element.localName === "style") {
        const css = element.textContent ?? "";
        if (/@import\b/i.test(css) || !localCssResources(css) || /\\/.test(css)) {
          throw new Error("Unsafe SVG stylesheet resource");
        }
      }
    }
    return Buffer.from(doc.documentElement.outerHTML);
  } finally { dom.window.close(); }
}

async function validateRaster(input: Buffer, baseUrl?:string): Promise<{ buffer: Buffer; extension: string; resources?:SvgContext["resources"] }> {
  // Include XML processing instructions/doctype prefixes in the sanitizer
  // path, rather than accidentally passing them straight to a rasterizer.
  const isSvg = /^\uFEFF?\s*</.test(input.toString("utf8", 0, 1024));
  const context:SvgContext={baseUrl,deadline:Date.now()+20_000,fonts:[],resources:[]};
  const bytes = isSvg ? await safeSvg(input,undefined,0,context) : input;
  const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "warning", density: 96 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION
    || metadata.width * metadata.height > MAX_PIXELS) throw new Error("Article image exceeds pixel/dimension limit");
  if (!["jpeg", "png", "webp", "gif", "heif", "avif", "tiff", "svg"].includes(metadata.format ?? "")) {
    throw new Error("Unsupported article image format");
  }
  // Full decoding detects corrupt/truncated raster data; normalize the first
  // frame to PNG so downstream OCR need not support each publisher format.
  let output:Buffer;
  if(context.fonts.length){
    const directory=await fs.mkdtemp(path.join(tmpdir(),"tweetmd-svg-fonts-"));
    try{
      const fontFiles:string[]=[];
      for(const [index,font] of context.fonts.entries()){
        const file=path.join(directory,`${index}.otf`);await fs.writeFile(file,svgFontToSfnt(font),{mode:0o600});
        const family=svgFontFamilyNames(font)[0];if(!family)throw new Error("SVG font has no verified family");
        verifySvgFontRendering(file,family);fontFiles.push(file);
      }
      const rendered=await renderAsync(bytes,{font:{fontFiles,loadSystemFonts:true},background:context.background,dpi:96},AbortSignal.timeout(15_000));
      if(rendered.width>MAX_DIMENSION||rendered.height>MAX_DIMENSION||rendered.width*rendered.height>MAX_PIXELS)throw new Error("SVG rendered image exceeds pixel/dimension limit");
      output=rendered.asPng();
    }finally{await fs.rm(directory,{recursive:true,force:true});}
  }else output = await image.timeout({ seconds: 15 }).png().toBuffer();
  if (output.byteLength > REFERENCE_IMAGE_MAX_BYTES) throw new Error("Rasterized article image exceeds 8 MB limit");
  return { buffer: output, extension: ".png", resources:context.resources.length?context.resources:undefined };
}

async function sourceBytes(url: string): Promise<{ bytes: Buffer; finalUrl: string }> {
  if (url.startsWith("data:image/")) {
    const match = url.match(/^data:image\/(svg\+xml|png|jpeg|webp|gif|avif)(;base64)?,([^]*)$/i);
    if (!match || match[3].length > REFERENCE_IMAGE_MAX_BYTES * 2) throw new Error("Unsupported or oversized inline article image");
    const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
    if (bytes.byteLength > REFERENCE_IMAGE_MAX_BYTES) throw new Error("Article image exceeds 8 MB limit");
    return { bytes, finalUrl: url };
  }
  // Dynamic import avoids an eager cycle: links owns extraction orchestration
  // and exports the guarded, redirect-checked and byte-capped fetch primitive.
  const { httpGet } = await import("./links.js");
  const response = await httpGet(url, "image/*");
  if (!response) throw new Error("Article image fetch failed");
  if (response.truncated || response.buf.byteLength > REFERENCE_IMAGE_MAX_BYTES) throw new Error("Article image exceeds 8 MB limit");
  return { bytes: response.buf, finalUrl: response.finalUrl };
}

async function reusable(media: MediaItem, outDir: string): Promise<boolean> {
  if (!media.localPath) return false;
  const absolute = path.resolve(outDir, media.localPath);
  const allowed = path.resolve(outDir, "refs", "media") + path.sep;
  if (!absolute.startsWith(allowed)) return false;
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size === 0 || stat.size > REFERENCE_IMAGE_MAX_BYTES || (media.bytes !== undefined && stat.size !== media.bytes)) return false;
    const metadata = await sharp(absolute, { limitInputPixels: MAX_PIXELS, failOn: "warning" }).metadata();
    return !!metadata.width && !!metadata.height && metadata.width <= MAX_DIMENSION && metadata.height <= MAX_DIMENSION;
  } catch { return false; }
}

/** Merges discoveries, preserves previous source images/OCR, and records every failure. */
export async function downloadReferenceImages(reference: LinkedReference, outDir: string, opts: ReferenceImageOptions = {}): Promise<void> {
  const byUrl = new Map<string, MediaItem>();
  for (const item of reference.media ?? []) {
    try { byUrl.set(canonicalReferenceImageUrl(item.url), item); }
    catch { byUrl.set(item.url, item); }
  }
  for (const image of opts.images ?? []) {
    let key: string;
    try { key = canonicalReferenceImageUrl(image.url); } catch { key = image.url; }
    const prior = byUrl.get(key);
    if (prior) {
      prior.altText ||= image.altText;
      prior.caption ||= image.caption;
    } else byUrl.set(key, { ...image, url: key, type: "photo" });
  }
  if (opts.images) reference.imageDiscoveryVersion = WEB_IMAGE_DISCOVERY_VERSION;
  reference.media = [...byUrl.values()];
  const maxImages = Math.max(0, Math.min(opts.maxImages ?? REFERENCE_IMAGE_MAX_COUNT, REFERENCE_IMAGE_MAX_COUNT));
  const mediaDir = path.join(outDir, "refs", "media");
  await fs.mkdir(mediaDir, { recursive: true });
  for (const [index, media] of reference.media.entries()) {
    if (opts.resume && await reusable(media, outDir)) { delete media.downloadError; continue; }
    if (index >= maxImages) { media.downloadError = `Article image count exceeds ${maxImages} per-source limit`; continue; }
    // Preserve success until replacement succeeds; never erase working OCR.
    const previousPath = media.localPath;
    try {
      const key = referenceImageKey(media.url);
      const destination = path.join(mediaDir, `${key}.png`);
      const relative = path.join("refs", "media", `${key}.png`);
      const candidate: MediaItem = { ...media, localPath: relative };
      if (opts.resume && await reusable(candidate, outDir)) {
        media.localPath = relative;
        media.bytes = (await fs.stat(destination)).size;
        delete media.downloadError;
        continue;
      }
      opts.onStatus?.(`Downloading linked article image ${index + 1}/${reference.media.length}…`);
      const fetched = await sourceBytes(canonicalReferenceImageUrl(media.url));
      const raster = await validateRaster(fetched.bytes,fetched.finalUrl);
      // A stable URL's first successfully validated file is immutable. Resume
      // uses it; changing remote bytes cannot silently invalidate saved OCR.
      await fs.writeFile(destination, raster.buffer, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        if (!(await reusable({ ...media, localPath: relative, bytes: undefined }, outDir))) {
          // An interrupted/invalid file was never a successful immutable asset.
          await fs.rm(destination, { force: true });
          await fs.writeFile(destination, raster.buffer, { flag: "wx" });
        }
      });
      media.localPath = relative;
      media.finalUrl = fetched.finalUrl;
      media.bytes = (await fs.stat(destination)).size;
      media.styleResources=raster.resources;
      delete media.downloadError;
    } catch (error) {
      media.downloadError = (error as Error).message;
      if (!previousPath) delete media.localPath;
    }
  }
}
