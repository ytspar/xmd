/** Persist public caption results beside the tweet/article that referenced them. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { allTweets } from "./x-parse.js";
import { fetchVideoTranscript, formatTranscriptMarkdown, CAPTION_PARSER_VERSION, youtubeVideoId, type CaptionTrack, type VideoTranscript } from "./transcripts.js";
import type { SavedFile, Thread } from "./types.js";

export async function captureTranscripts(thread: Thread, outDir: string, opts: { resume?: boolean; onStatus?: (message: string) => void; fetchTranscript?: typeof fetchVideoTranscript } = {}): Promise<{ completed: number; total: number }> {
  const requests = new Map<string, Promise<VideoTranscript>>();
  const fetcher = opts.fetchTranscript ?? fetchVideoTranscript;
  let completed = 0, total = 0;
  const resolve = async (url: string, tracks: CaptionTrack[] | undefined, previous?: VideoTranscript, allowPublicCaptionTracks = false) => {
    total++;
    let result = previous;
    if (!(opts.resume && previous?.status === "complete" && previous.parserVersion === CAPTION_PARSER_VERSION && previous.text && previous.segments.length)) {
      const key = `${youtubeVideoId(url) ?? url}\0${(tracks ?? []).map((track) => track.url).sort().join("\0")}`;
      let pending = requests.get(key);
      if (!pending) { pending = fetcher(url, { captionTracks: tracks, allowPublicCaptionTracks }); requests.set(key, pending); }
      opts.onStatus?.(`Fetching available video captions: ${url}`);
      const fetched = await pending;
      if (previous?.text && previous.segments.length && (fetched.status === "unavailable" || (fetched.status === "partial" && fetched.text.length < previous.text.length))) {
        result = { ...previous, status: "partial", error: `Caption retry failed or returned less content; retained prior transcript. ${fetched.error ?? ""}`.trim() };
      } else result = fetched;
    }
    if (result?.status === "complete") completed++;
    return result!;
  };
  const save = async (result: VideoTranscript): Promise<SavedFile | undefined> => {
    if (!result.text || !result.segments.length) return undefined;
    const localPath = `refs/transcripts/${createHash("sha256").update(`${result.sourceUrl}\0${result.captionUrl ?? ""}`).digest("hex")}.md`;
    const text = formatTranscriptMarkdown(result);
    await fs.mkdir(path.join(outDir, "refs/transcripts"), { recursive: true });
    await fs.writeFile(path.join(outDir, localPath), text);
    return { localPath, bytes: Buffer.byteLength(text), truncated: result.truncated };
  };
  for (const ref of thread.references ?? []) {
    if (ref.kind === "video") {
      ref.transcript = await resolve(ref.url, undefined, ref.transcript);
      const file = await save(ref.transcript);
      if (file) ref.files = [file];
    }
    for (const video of ref.videos ?? []) {
      video.transcript = await resolve(video.url, video.captionTracks, video.transcript, !!video.captionTracks?.length);
      video.file = await save(video.transcript);
    }
  }
  for (const tweet of allTweets(thread)) {
    for (const media of tweet.media.filter((media) => media.type === "video")) {
      media.transcript = await resolve(tweet.url || media.videoUrl || media.url, media.captionTracks, media.transcript);
      media.transcriptFile = await save(media.transcript);
    }
  }
  return { completed, total };
}
