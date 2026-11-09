/** Shared linked-source media view and deterministic local document rendering. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isValidEnrichment } from "./enrich.js";
import { formatTranscriptMarkdown } from "./transcripts.js";
import { referenceImageKey } from "./reference-images.js";
import type { LinkedReference, MediaItem, Thread } from "./types.js";

export function referenceImageThread(thread: Thread): Thread {
  const seen = new Map<string, MediaItem>();
  const replies = (thread.references ?? []).map((ref) => {
    const media = (ref.media ?? []).filter((image) => {
      const key = referenceImageKey(image.url);
      if (seen.has(key)) return false;
      seen.set(key, image); return true;
    });
    return { ...thread.main, id: `reference-${createHash("sha256").update(ref.url).digest("hex")}`, text: `Linked article: ${ref.title}\n${ref.url}\n${media.map((image) => image.caption ?? image.altText ?? "").join("\n")}`, media, quoted: undefined, embeddedTweets: undefined, isMainTweet: false };
  });
  return { ...thread, main: { ...thread.main, media: [], quoted: undefined, embeddedTweets: undefined }, ancestors: [], replies, linkedTweets: undefined, references: undefined };
}

export function shareReferenceAnalysis(thread: Thread): void {
  const images = (thread.references ?? []).flatMap((ref) => ref.media ?? []);
  const skipped = new Map(images.filter((image) => image.enrichmentSkipped?.startsWith("Icon-sized")).map((image) => [referenceImageKey(image.url), image.enrichmentSkipped]));
  const accepted = new Map(images.filter((image) => isValidEnrichment(image.enrichment)).map((image) => [referenceImageKey(image.url), image.enrichment]));
  for (const image of images) {
    const result = accepted.get(referenceImageKey(image.url));
    if (result) { image.enrichment = result; delete image.enrichmentError; }
    else if (skipped.has(referenceImageKey(image.url))) { image.enrichmentSkipped = skipped.get(referenceImageKey(image.url)); delete image.enrichmentError; }
  }
}

export function referenceWarnings(ref: LinkedReference): string[] {
  const warnings = [ref.extractionWarning ?? ref.warning?.replace(/\d+ linked article image\(s\) retained by URL; image bytes and OCR are not captured\./g, "").trim() ?? ""].filter(Boolean);
  const images = ref.media ?? [];
  const missing = images.filter((image) => !image.localPath || image.downloadError);
  const unread = images.filter((image) => !isValidEnrichment(image.enrichment) && !image.enrichmentSkipped?.startsWith("Icon-sized"));
  if (missing.length) warnings.push(`${missing.length}/${images.length} linked article images were not downloaded.`);
  if (unread.length) warnings.push(`${unread.length}/${images.length} linked article images lack OCR/analysis.`);
  for (const video of ref.videos ?? []) if (video.transcript?.status !== "complete") warnings.push(`Video transcript ${video.transcript?.status ?? "pending"}: ${video.url}${video.transcript?.error ? ` (${video.transcript.error})` : ""}`);
  return [...new Set(warnings)];
}

export function updateReferenceCoverage(ref: LinkedReference): void {
  if (ref.kind === "video") {
    ref.status = ref.transcript?.status === "complete" ? "complete" : "partial";
    ref.warning = ref.status === "complete" ? undefined : ref.transcript?.error ?? "Video transcript unavailable.";
    return;
  }
  const warnings = referenceWarnings({ ...ref, warning: ref.extractionWarning ?? (ref.textStatus ? undefined : ref.warning) });
  if (ref.error) warnings.unshift(ref.error);
  ref.warning = warnings.join(" ") || undefined;
  ref.status = !ref.files.length ? "failed" : warnings.length || ref.resolution === "abstract-only" || ref.resolution === "unknown" || ref.files.some((file) => file.truncated) ? "partial" : "complete";
}

function imageBlock(image: MediaItem, docPath: string): string {
  const lines: string[] = [];
  if (image.localPath) lines.push(`![${(image.altText ?? image.caption ?? "Article image").replace(/[\[\]\n]/g, " ")}](${path.relative(path.dirname(docPath), image.localPath)})`);
  if (image.caption) lines.push(`*Caption:* ${image.caption}`);
  if (image.enrichment?.description) lines.push(`*Image description:* ${image.enrichment.description}`);
  if (image.enrichment?.content) lines.push(image.enrichment.content);
  if (image.downloadError) lines.push(`> Image download unavailable: ${image.downloadError}`);
  if (image.enrichmentError) lines.push(`> Image analysis unavailable: ${image.enrichmentError}`);
  if (!image.localPath) lines.push(`[Original image](${image.url})`);
  return lines.join("\n\n");
}

export async function renderReferenceDocuments(thread: Thread, outDir: string): Promise<void> {
  for (const ref of thread.references ?? []) {
    // Raw repository/registry documents do not use the HTML image extractor.
    // A saved README must not silently claim that its referenced images were
    // captured, particularly when relative paths are broken in the bundle.
    if (ref.kind !== "web" && ref.kind !== "video" && !ref.imageDiscoveryVersion && !ref.media?.length) {
      let imageCount = 0;
      for (const file of ref.files) {
        const absolute = path.resolve(outDir, file.localPath);
        if (!absolute.startsWith(path.resolve(outDir) + path.sep)) continue;
        const body = await fs.readFile(absolute, "utf8").catch(() => "");
        imageCount += [...body.matchAll(/!\[[^\]]*\]\([^\n]+?\)|<img\b[^>]*>/gi)].length;
      }
      if (imageCount) {
        const warning = "Repository/registry document images are retained as source links; image bytes and OCR are not captured.";
        if (!ref.extractionWarning?.includes(warning)) ref.extractionWarning = [ref.extractionWarning, warning].filter(Boolean).join(" ");
        updateReferenceCoverage(ref);
      }
    }
    if (ref.kind === "video" || (!ref.media?.length && !ref.videos?.length)) continue;
    for (const file of ref.files) {
      try {
      const absolute = path.resolve(outDir, file.localPath);
      if (!absolute.startsWith(path.resolve(outDir) + path.sep)) throw new Error("Reference file outside bundle");
      const source = path.resolve(outDir, file.sourcePath ?? file.localPath);
      if (!source.startsWith(path.resolve(outDir) + path.sep)) throw new Error("Reference source outside bundle");
      const raw = await fs.readFile(source, "utf8");
      if (!file.sourcePath) {
        file.sourcePath = `${file.localPath}.source.md`;
        await fs.writeFile(path.join(outDir, file.sourcePath), raw);
      }
      const images = new Map((ref.media ?? []).map((image) => [referenceImageKey(image.url), image]));
      let body = raw.replace(/\[\[reference-image:([a-f0-9]+)\]\]/g, (marker, key: string) => images.has(key) ? imageBlock(images.get(key)!, file.localPath) : `> Unresolved article image: ${key}`);
      for (const video of ref.videos ?? []) {
        body += `\n\n## Video transcript\n\nSource: ${video.url}\n\n${video.transcript?.text ? formatTranscriptMarkdown(video.transcript) : video.transcript?.error || "Transcript not captured."}\n`;
      }
      await fs.writeFile(absolute, body);
      file.bytes = Buffer.byteLength(body);
      } catch (error) {
        ref.error = `Reference rendering unavailable: ${(error as Error).message}`;
        ref.status = "partial";
        ref.warning = ref.error;
      }
    }
  }
}
