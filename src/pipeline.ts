/** End-to-end capture with durable per-stage checkpoints and explicit partial outcomes. */
import fs from "node:fs/promises";
import { normalizeLegacyArticleMarkers } from "./article.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { scrapeThread } from "./scrape.js";
import { downloadReferenceImages } from "./reference-images.js";
import { referenceImageThread, shareReferenceAnalysis, renderReferenceDocuments, updateReferenceCoverage } from "./reference-content.js";
import { captureTranscripts } from "./video-content.js";
import { downloadAllMedia, pruneDecorativeMedia } from "./media.js";
import { enrichImages, isValidEnrichment } from "./enrich.js";
import { fetchReferences, payloadTweets } from "./links.js";
import { bundleDir, bundleSlug, writeBundle, type WriteResult } from "./render.js";
import { assignCategory, regenerateCategoriesMd, setCategory, classificationContext, loadManifest, taxonomyVersion } from "./categorize.js";
import { allTweets, statusIdFromUrl } from "./x-parse.js";
import { newCaptureReport, setStage, finalizeCapture, captureSummary } from "./capture.js";
import { followLinkedTweets, refreshIncompleteArticles } from "./linked-tweets.js";
import { preflightClaude, type ProviderStatus } from "./provider.js";
import { acquireLease } from "./lock.js";
import type { CaptureStageName, Thread } from "./types.js";

export async function findExistingBundle(outBase: string, url: string): Promise<string | null> {
  const id = statusIdFromUrl(url);
  if (!id) return null;
  const entries = await fs.readdir(outBase, { withFileTypes: true }).catch(() => []);
  return entries.find((entry) => entry.isDirectory() && entry.name.endsWith(`_${id}`))?.name ?? null;
}

export interface PipelineOptions {
  url: string;
  /** Reuse saved text; retry only incomplete stages/assets. */
  resume?: boolean;
  provider?: ProviderStatus;
  linkedTweetLimit?: number;
  transcripts?: boolean;
  outBase: string;
  headless: boolean;
  enrich: boolean;
  scrolls?: number;
  /** Override the strong model used for image enrichment. */
  model?: string;
  /** Override the cheap first-pass / Mermaid-repair model. */
  cheapModel?: string;
  /** Disable the cheap→strong cascade; use the strong model for every image. */
  tiered?: boolean;
  /** Also enrich video/GIF poster frames (default: false). */
  enrichPosters?: boolean;
  /** Skip the image-enrichment content-hash cache. */
  noCache?: boolean;
  /** Follow GitHub/gist links in the thread and save their content (default: true). */
  links?: boolean;
  /** Follow generic web links from every poster, not just the original author. */
  allLinks?: boolean;
  /**
   * Classify against existing topics via `claude -p`, retaining proposed
   * additions for review in `<out>/categories.json` (default: true). Best
   * effort — never fails the capture.
   */
  categorize?: boolean;
  /**
   * File the capture under this explicit `category[/subcategory]` instead of
   * asking `claude -p`. Missing categories are created. Takes precedence over
   * `categorize`.
   */
  category?: string;
}

export type ProgressEvent =
  | { type: "status"; message: string }
  | { type: "done"; result: WriteResult; thread: Thread }
  | { type: "error"; error: string };

/** Injectable stage implementations permit deterministic failure/recovery tests. */
export interface PipelineServices {
  scrape: typeof scrapeThread;
  media: typeof downloadAllMedia;
  enrich: typeof enrichImages;
  references: typeof fetchReferences;
  categorize: typeof assignCategory;
  provider: typeof preflightClaude;
  referenceImages: typeof downloadReferenceImages;
  transcripts: typeof captureTranscripts;
}
const defaults: PipelineServices = { scrape: scrapeThread, media: downloadAllMedia, enrich: enrichImages, references: fetchReferences, categorize: assignCategory, provider: preflightClaude, referenceImages: downloadReferenceImages, transcripts: captureTranscripts };

export async function* runPipeline(opts: PipelineOptions, overrides: Partial<PipelineServices> = {}): AsyncGenerator<ProgressEvent> {
  const services = { ...defaults, ...overrides };
  const messages: string[] = [];
  const status = (message: string) => messages.push(message);
  const flush = function* (): Generator<ProgressEvent> {
    while (messages.length) yield { type: "status", message: messages.shift()! };
  };
  let release: (() => Promise<void>) | undefined;
  try {
    const id = statusIdFromUrl(opts.url);
    if (!id) throw new Error(`Could not find a status id in URL: ${opts.url}`);
    release = await acquireLease(path.join(opts.outBase, ".locks", `${id}.lock`));
    const existing = await findExistingBundle(opts.outBase, opts.url);
    let thread: Thread;
    if (opts.resume && existing) {
      thread = JSON.parse(await fs.readFile(path.join(opts.outBase, existing, "thread.json"), "utf8"));
      if (thread.main.id !== id) throw new Error("Saved bundle does not match requested status ID.");
      status("Resuming saved text; retrying incomplete stages only.");
    } else {
      if (existing) status(`Re-capturing ${existing}; use --resume to retry incomplete stages.`);
      thread = await services.scrape({ url: opts.url, headless: opts.headless, scrolls: opts.scrolls, onStatus: status });
      thread.capture = newCaptureReport(thread);
    }
    for (const node of allTweets(thread)) if (node.isArticle) node.text = normalizeLegacyArticleMarkers(node.text);
    thread.capture ??= newCaptureReport(thread);
    thread.capture.stages.transcripts ??= {status: "pending"};
    thread.capture.status = "in-progress";
    const outDir = bundleDir(thread, opts.outBase);
    await fs.mkdir(outDir, { recursive: true });
    // The text checkpoint is independent of media, model authentication and links.
    const rawPath = path.join(outDir, "raw-thread.json");
    if (!opts.resume || !existing || !(await fs.stat(rawPath).catch(() => null))) {
      await fs.writeFile(rawPath, JSON.stringify(thread, null, 2) + "\n");
    }
    await writeBundle(thread, opts.outBase);
    yield* flush();
    yield { type: "status", message: `Text saved: ${thread.replies.length} replies served by X; conversation completeness is unknown.` };
    const checkpoint = async () => { await writeBundle(thread, opts.outBase); };
    const stage = async (name: CaptureStageName, work: () => Promise<void>) => {
      try { await work(); } catch (error) { setStage(thread, name, { status: "failed", message: (error as Error).message }); }
      await checkpoint();
    };

    await stage("articles", async () => {
      if (opts.resume) await refreshIncompleteArticles(thread, (url) => services.scrape({ url, headless: opts.headless, scrolls: 0, onStatus: status }), opts.linkedTweetLimit ?? 3);
      await followLinkedTweets(thread, (url) => services.scrape({ url, headless: opts.headless, scrolls: 0, onStatus: status }), { resume: opts.resume, limit: opts.links === false ? 0 : opts.linkedTweetLimit, onStatus: status });
      setStage(thread, "articles", { status: "complete" });
    });
    yield* flush();
    if (opts.links !== false) {
      await stage("references", async () => {
        await services.references(thread, outDir, { onStatus: status, allLinks: opts.allLinks, resume: !!opts.resume });
        setStage(thread, "references", { status: "complete" });
      });
    } else setStage(thread, "references", { status: "skipped", message: "Disabled with --no-links." });
    await checkpoint();
    yield* flush();

    await stage("media", async () => {
      await services.media(thread, outDir, status, { resume: !!opts.resume });
      if (opts.links !== false) for (const ref of thread.references ?? []) await services.referenceImages(ref, outDir, { resume: !!opts.resume, onStatus: status });
      const media = [...allTweets(thread).flatMap((tweet) => tweet.media), ...(thread.references ?? []).flatMap((ref) => ref.media ?? [])];
      const native = new Set(allTweets(thread).flatMap((tweet) => tweet.media));
      const completed = media.filter((item) => (item.localPath && !item.downloadError) || (native.has(item) && item.enrichment?.kind === "decorative")).length;
      setStage(thread, "media", { status: completed === media.length ? "complete" : "partial", completed, total: media.length });
    });
    yield* flush();

    let provider: ProviderStatus | undefined = opts.provider;
    const getProvider = async () => provider ??= await services.provider();
    if (opts.enrich) {
      await stage("ocr", async () => {
        const result = await services.enrich(thread, outDir, {
          provider: allTweets(thread).some((tweet) => tweet.media.some((media) => media.localPath && !media.enrichment)) ? await getProvider() : undefined, resume: !!opts.resume, onStatus: status,
          model: opts.model, cheapModel: opts.cheapModel, tiered: opts.tiered,
          enrichPosters: opts.enrichPosters, noCache: opts.noCache,
        });
        const articleImages = referenceImageThread(thread);
        const referenceResult = articleImages.replies.some((tweet) => tweet.media.length) ? await services.enrich(articleImages, outDir, {
          provider: (thread.references ?? []).some((ref) => ref.media?.some((image) => image.localPath && !isValidEnrichment(image.enrichment))) ? await getProvider() : provider,
          resume: true, onStatus: status, model: opts.model, cheapModel: opts.cheapModel, tiered: opts.tiered, noCache: opts.noCache,
        }) : undefined;
        shareReferenceAnalysis(thread);
        await pruneDecorativeMedia(thread, outDir);
        const targets = [...allTweets(thread).flatMap((tweet) => tweet.media), ...articleImages.replies.flatMap((tweet) => tweet.media)].filter((media) => media.type === "photo" || opts.enrichPosters);
        const missing = targets.filter((media) => !isValidEnrichment(media.enrichment) && !media.enrichmentSkipped?.startsWith("Icon-sized"));
        const primary = new Set([...payloadTweets(thread).flatMap((tweet) => tweet.media), ...articleImages.replies.flatMap((tweet) => tweet.media)]);
        const primaryTargets = targets.filter((media) => primary.has(media));
        const primaryMissing = missing.filter((media) => primary.has(media));
        const detail = `Author/quoted sources: ${primaryTargets.length - primaryMissing.length}/${primaryTargets.length} images analysed; supplemental discussion: ${targets.length - primaryTargets.length - (missing.length - primaryMissing.length)}/${targets.length - primaryTargets.length}.`;
        setStage(thread, "ocr", { status: missing.length ? "partial" : "complete", completed: targets.length - missing.length, total: targets.length, message: `${detail}${result.providerError || referenceResult?.providerError ? ` ${result.providerError ?? referenceResult?.providerError}` : missing.length ? " See per-media errors." : ""}` });
      });
    } else setStage(thread, "ocr", { status: "skipped", message: "Disabled with --no-enrich; images have no guaranteed text rendering." });
    await checkpoint();
    yield* flush();

    if (opts.transcripts !== false) await stage("transcripts", async () => {
      const result = await services.transcripts(thread, outDir, { resume: !!opts.resume, onStatus: status });
      setStage(thread, "transcripts", { status: result.completed === result.total ? "complete" : "partial", ...result, message: result.completed === result.total ? "All discovered available-caption targets resolved." : "Some videos have no available public captions; see per-video provenance/errors." });
    });
    else setStage(thread, "transcripts", {status: "skipped", message: "Disabled with --no-transcripts."});
    for (const ref of thread.references ?? []) updateReferenceCoverage(ref);
    await renderReferenceDocuments(thread, outDir);
    await checkpoint();
    yield* flush();

    if (opts.category || opts.categorize !== false) {
      await stage("category", async () => {
        const previous = thread.capture!.stages.category;
        // Explicit human assignments survive source repairs. Model evidence is
        // reusable only when content and the available topic hierarchy match.
        if (opts.resume && !opts.category && previous.status === "complete" && previous.assignment === "manual") return;
        const manifest = await loadManifest(opts.outBase);
        const retained = manifest.items.find((item) => item.slug === bundleSlug(thread));
        const retainedLabel = retained && retained.category !== "uncategorized" ? `${retained.category}${retained.subcategory ? `/${retained.subcategory}` : ""}` : undefined;
        if (opts.resume && !opts.category && retainedLabel && retained?.classification?.method === "manual" && !retained.classification.needsReview) {
          setStage(thread, "category", { status: "complete", assignment: "manual", message: `Retained explicit assignment ${retainedLabel}.` });
          return;
        }
        const inputHash = createHash("sha256").update(await classificationContext(thread, outDir)).update(taxonomyVersion(manifest)).digest("hex");
        if (opts.resume && !opts.category && ["complete", "partial"].includes(previous.status) && previous.inputHash === inputHash) return;
        const available = opts.category ? undefined : await getProvider();
        if (available && !available.available) {
          setStage(thread, "category", { status: retainedLabel ? "partial" : "failed", message: `${retainedLabel ? `Retained ${retainedLabel}; classification was not refreshed. ` : ""}${available.error ?? "Claude authentication unavailable."}` });
          return;
        }
        const assigned = opts.category ? await setCategory(thread, opts.outBase, opts.category) : await services.categorize(thread, opts.outBase, { onStatus: status, provider: available });
        setStage(thread, "category", { status: assigned ? (assigned.needsReview ? "partial" : "complete") : "failed", inputHash, assignment: opts.category ? "manual" : "model", message: assigned ? `${assigned.category}${assigned.subcategory ? `/${assigned.subcategory}` : ""}${assigned.needsReview ? " — needs taxonomy review" : ""}` : "No classification returned." });
        await regenerateCategoriesMd(opts.outBase);
      });
    } else setStage(thread, "category", { status: "skipped", message: "Disabled with --no-categorize." });
    yield* flush();
    finalizeCapture(thread);
    const result = await writeBundle(thread, opts.outBase);
    yield { type: "status", message: captureSummary(thread) };
    yield { type: "done", result, thread };
  } catch (error) {
    yield* flush();
    yield { type: "error", error: (error as Error).message };
  } finally { await release?.(); }
}
