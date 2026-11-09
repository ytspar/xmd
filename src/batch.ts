/** Sequential capture avoids sharing the persistent browser profile between writers. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { tweetUrls } from "./input.js";
import { runPipeline, type PipelineOptions, type ProgressEvent } from "./pipeline.js";
import { preflightClaude } from "./provider.js";
import { acquireLease } from "./lock.js";

export interface BatchItem { url: string; status: "pending" | "running" | "complete" | "partial" | "failed"; outDir?: string; error?: string }
export interface BatchReport { version: 1; updatedAt: string; items: BatchItem[] }
export async function* runBatch(input: string, opts: Omit<PipelineOptions, "url">, services: { pipeline?: typeof runPipeline; provider?: typeof preflightClaude } = {}): AsyncGenerator<ProgressEvent | { type: "batch"; path: string; report: BatchReport }> {
  const urls = tweetUrls(input);
  if (!urls.length) throw new Error("No X/Twitter status URLs found in batch input.");
  const key = createHash("sha256").update(urls.join("\n")).digest("hex").slice(0, 16);
  const dir = path.join(opts.outBase, ".batches");
  const reportPath = path.join(dir, `${key}.json`);
  await fs.mkdir(dir, { recursive: true });
  const release = await acquireLease(`${reportPath}.lock`);
  try {
    const report: BatchReport = { version: 1, updatedAt: new Date().toISOString(), items: urls.map((url) => ({ url, status: "pending" })) };
    const save = async () => {
      report.updatedAt = new Date().toISOString();
      const tmp = `${reportPath}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(report, null, 2) + "\n");
      await fs.rename(tmp, reportPath);
    };
    await save();
    // One shared check for every optional model stage in this batch.
    const needsAI = opts.enrich || (!opts.category && opts.categorize !== false);
    const provider = opts.provider ?? (needsAI ? await (services.provider ?? preflightClaude)() : undefined);
    for (const [index, item] of report.items.entries()) {
      item.status = "running";
      await save();
      yield { type: "status", message: `Batch ${index + 1}/${urls.length}: ${item.url}` };
      for await (const event of (services.pipeline ?? runPipeline)({ ...opts, provider, url: item.url })) {
        if (event.type === "done") { item.status = event.thread.capture?.status === "complete" ? "complete" : "partial"; item.outDir = event.result.outDir; }
        if (event.type === "error") { item.status = "failed"; item.error = event.error; }
        await save();
        yield event;
      }
      await save();
    }
    yield { type: "batch", path: reportPath, report };
  } finally { await release(); }
}
