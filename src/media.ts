/** Download tweet media into the output folder. */
import fs from "node:fs/promises";
import path from "node:path";
import { allTweets } from "./x-parse.js";
import type { Thread } from "./types.js";

function extFromUrl(url: string, fallback = ".jpg"): string {
  const clean = url.split("?")[0];
  const ext = path.extname(clean);
  return ext || fallback;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

/**
 * Download every photo (and the poster of GIFs/videos) referenced in the
 * thread into `<outDir>/media`, recording the relative path on each MediaItem.
 */
export async function downloadAllMedia(
  thread: Thread,
  outDir: string,
  onStatus: (message: string) => void = () => {},
  opts: { resume?: boolean } = {},
): Promise<void> {
  const mediaDir = path.join(outDir, "media");
  // Clear stale files so a re-capture's media/ matches this run exactly.
  if (!opts.resume) await fs.rm(mediaDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(mediaDir, { recursive: true });

  const everyTweet = allTweets(thread);
  let n = 0;
  const total = everyTweet.reduce((acc, t) => acc + t.media.length, 0);

  for (const tweet of everyTweet) {
    for (let i = 0; i < tweet.media.length; i++) {
      const m = tweet.media[i];
      if (opts.resume && m.enrichment?.kind === "decorative") continue;
      if (opts.resume && m.localPath) {
        const existing = path.resolve(outDir, m.localPath);
        if (existing.startsWith(path.resolve(outDir) + path.sep) && await fs.stat(existing).then((st) => st.isFile() && st.size > 0).catch(() => false)) {
          delete m.downloadError;
          continue;
        }
      }
      delete m.localPath;
      delete m.downloadError;
      // Photos download directly; for video/GIF, `m.url` is the poster frame —
      // a still image we can OCR/describe so a text reader knows what's in it.
      n++;
      const index = m.inline && m.articleIndex !== undefined ? m.articleIndex : i;
      const filename = `${tweet.id}-${index}${extFromUrl(m.url)}`;
      const dest = path.join(mediaDir, filename);
      onStatus(`Downloading media ${n}/${total}…`);
      try {
        await download(m.url, dest);
        m.localPath = path.join("media", filename);
      } catch (err) {
        m.downloadError = (err as Error).message;
        onStatus(`Skipped a media file (${m.downloadError})`);
      }
    }
  }
}

/**
 * Drop images the enrichment judged purely decorative: a decorative image adds
 * nothing a text reader can use, so we delete the file and clear its local path
 * (the short description in the enrichment is kept). Images with real content —
 * screenshots, tables, diagrams — are left in place. Returns how many were
 * removed. No-op for images that weren't enriched (e.g. `--no-enrich`).
 */
export async function pruneDecorativeMedia(thread: Thread, outDir: string): Promise<number> {
  let removed = 0;
  for (const tweet of allTweets(thread)) {
    for (const m of tweet.media) {
      if (m.enrichment?.kind === "decorative" && m.localPath) {
        await fs.rm(path.resolve(outDir, m.localPath), { force: true }).catch(() => {});
        m.localPath = undefined; // render shows the description, not the image
        removed++;
      }
    }
  }
  return removed;
}
