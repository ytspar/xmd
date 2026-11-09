import type { CaptionTrack, VideoTranscript } from "./transcripts.js";
/** Structured representation of a captured tweet thread. */

export interface ImageEnrichment {
  /**
   * What the image is, which determines how `content` is rendered:
   * - "flowchart" → `content` is a ```mermaid block
   * - "table"     → `content` is a Markdown table
   * - "text"      → `content` is a faithful Markdown transcription (slides, docs, code, charts)
   * - "diagram"   → `content` is a best-effort text/Markdown rendering
   * - "decorative"→ no `content`; `description` alone suffices
   */
  kind?: "flowchart" | "table" | "text" | "diagram" | "decorative";
  /** Short (1-2 sentence) plain description of the image. Always present. */
  description?: string;
  /** Ready-to-embed Markdown rendering of the image's information (null if decorative). */
  content?: string;
}

export interface MediaItem {
  /** Original CDN url (highest resolution we could request). */
  url: string;
  type: "photo" | "video" | "animated_gif";
  /** Alt text supplied by the tweet author, if present. */
  altText?: string;
  caption?: string;
  finalUrl?: string;
  /** Fetched/inlined SVG style/font provenance; embedded data is identified by hash. */
  styleResources?: {url:string;bytes:number;kind:"stylesheet"|"font"}[];
  bytes?: number;
  videoUrl?: string;
  captionTracks?: CaptionTrack[];
  transcript?: VideoTranscript;
  transcriptFile?: SavedFile;
  /** Path of the downloaded file, relative to the output folder. */
  localPath?: string;
  downloadError?: string;
  enrichmentError?: string;
  enrichmentSkipped?: string;
  /** True when the image is already embedded inline in the tweet text (X Articles). */
  inline?: boolean;
  /**
   * Position in the source X Article's `media_entities` array (inline images
   * only). Some entries there are skipped (no resolvable image URL), so this
   * can diverge from this item's own position in `media[]` — the body's
   * `![article image](media/<id>-<articleIndex>.<ext>)` placeholders embed
   * this index, and matching on it (not array position) keeps each
   * placeholder pointed at its real image regardless of what got skipped.
   */
  articleIndex?: number;
  /** AI-derived OCR / mermaid / description (photos only). */
  enrichment?: ImageEnrichment;
  enrichmentReview?: {method:"manual";reviewedAt:string;reason:string};
}

export interface TweetMetrics {
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  bookmarks?: number;
  views?: number;
}

export interface TweetNode {
  id: string;
  url: string;
  author: {
    name: string;
    handle: string;
  };
  text: string;
  /** Raw X timestamp, e.g. "Wed Oct 25 18:00:00 +0000 2023". */
  createdAtRaw: string;
  /** ISO 8601, best-effort parse of createdAtRaw. */
  createdAt?: string;
  metrics: TweetMetrics;
  media: MediaItem[];
  isMainTweet: boolean;
  /** True when `text` is rendered long-form Article Markdown (not a short tweet). */
  isArticle?: boolean;
  /** Article exists but its body/assets may not have been served. */
  articleIssues?: string[];
  /** The tweet this one quotes, if any (its own replies are not captured). */
  quoted?: TweetNode;
  /** Tweets an X Article embeds inline in its body (rendered at `[[embedded-tweet:ID]]` markers in `text`). */
  embeddedTweets?: TweetNode[];
}

/** One file saved for a reference (a link can yield several, e.g. a gist). */
export interface SavedFile {
  /** Saved copy, relative to the bundle (refs/…). */
  localPath: string;
  /** Immutable extracted body, before media/transcript rendering. */
  sourcePath?: string;
  bytes: number;
  /** True when the content was capped at the size limit. */
  truncated?: boolean;
  title?: string;
  finalUrl?: string;
  canonicalUrl?: string;
  extractionMethod?: LinkedReference["extractionMethod"];
  extractionVersion?: string;
  resolution?: LinkedReference["resolution"];
  warning?: string;
}

/** A link found in a tweet whose content we fetched for reference. */
export interface LinkedReference {
  /** Original URL as it appeared in the tweet. */
  url: string;
  kind: "github-file" | "github-repo" | "gist" | "npm" | "pypi" | "web" | "video";
  finalUrl?: string;
  canonicalUrl?: string;
  fetchedAt?: string;
  extractionMethod?: "readability" | "semantic" | "body" | "plain-text" | "source";
  extractionVersion?: string;
  status?: "complete" | "partial" | "failed" | "skipped";
  warning?: string;
  provenance?: "author" | "quoted" | "embedded" | "reply" | "discovered";
  resolution?: "full-text" | "abstract-only" | "unknown";
  textStatus?: "complete" | "partial" | "failed";
  attemptedUrl?: string;
  media?: MediaItem[];
  imageDiscoveryVersion?: string;
  extractionWarning?: string;
  transcript?: VideoTranscript;
  videos?: { url: string; captionTracks?: CaptionTrack[]; transcript?: VideoTranscript; file?: SavedFile }[];
  /** Id of the tweet that contained the link. */
  sourceTweetId: string;
  /** Human label, e.g. `owner/repo: path` or a page title. */
  title: string;
  /** Saved copies (empty when the fetch failed). */
  files: SavedFile[];
  /** Set when the fetch failed. */
  error?: string;
}

export type StageState = "pending" | "complete" | "partial" | "failed" | "skipped";
export interface CaptureStage {
  status: StageState;
  inputHash?: string;
  assignment?: "manual" | "model";
  message?: string;
  completed?: number;
  total?: number;
}
export type CaptureStageName = "text" | "articles" | "media" | "ocr" | "references" | "transcripts" | "category";
export interface CaptureReport {
  version: 1;
  status: "in-progress" | "complete" | "partial";
  updatedAt: string;
  stages: Record<CaptureStageName, CaptureStage>;
  warnings: string[];
  conversation: { capturedReplies: number; reportedReplies: number; completeness: "unknown" };
}
export interface LinkedTweet {
  url: string;
  sourceTweetId: string;
  status: "complete" | "partial" | "failed" | "skipped";
  error?: string;
  thread?: Thread;
}

export interface Thread {
  /** The tweet referenced by the input URL. */
  main: TweetNode;
  /** Tweets above the main tweet (the author's own preceding thread). */
  ancestors: TweetNode[];
  /** Replies / commentary below the main tweet, in display order. */
  replies: TweetNode[];
  /** Fetched copies of GitHub/gist links found in the thread. */
  references?: LinkedReference[];
  linkedTweets?: LinkedTweet[];
  capture?: CaptureReport;
  capturedAt: string;
  sourceUrl: string;
}
