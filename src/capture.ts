/** Explicit, persisted capture coverage. A saved bundle is not a completeness claim. */
import { payloadTweets } from "./links.js";
import { allTweets } from "./x-parse.js";
import type { CaptureReport, CaptureStage, CaptureStageName, Thread } from "./types.js";

export function newCaptureReport(thread: Thread): CaptureReport {
  const pending = (): CaptureStage => ({ status: "pending" });
  return {
    version: 1, status: "in-progress", updatedAt: new Date().toISOString(),
    stages: { text: { status: "complete" }, articles: pending(), media: pending(), ocr: pending(), references: pending(), transcripts: pending(), category: pending() },
    warnings: [], conversation: { capturedReplies: thread.replies.length, reportedReplies: thread.main.metrics.replies, completeness: "unknown" },
  };
}

export function setStage(thread: Thread, name: CaptureStageName, stage: CaptureStage): void {
  thread.capture ??= newCaptureReport(thread);
  thread.capture.stages[name] = stage;
  thread.capture.updatedAt = new Date().toISOString();
}

export function articleIssues(thread: Thread, scope: "all" | "payload" | "supplemental" = "all"): string[] {
  const primary = new Set(payloadTweets(thread).map((tweet) => tweet.id));
  const issues: string[] = [];
  for (const tweet of allTweets(thread)) {
    if (scope === "payload" && !primary.has(tweet.id)) continue;
    if (scope === "supplemental" && primary.has(tweet.id)) continue;
    for (const issue of tweet.articleIssues ?? []) issues.push(`${tweet.id}: ${issue}`);
    for (const match of tweet.text.matchAll(/\[Original image:\s*([^\]]+)\]/g)) issues.push(`${tweet.id}: unresolved article image ${match[1]}`);
    for (const match of tweet.text.matchAll(/\[Unsupported article entity:\s*([^\]]+)\]/g)) issues.push(`${tweet.id}: unsupported article element ${match[1]}`);
    for (const match of tweet.text.matchAll(/\[\[embedded-tweet:(\d+)\]\]/g)) {
      if (!tweet.embeddedTweets?.some((node) => node.id === match[1])) issues.push(`${tweet.id}: unresolved embedded tweet ${match[1]}`);
    }
  }
  for (const link of scope === "supplemental" ? [] : thread.linkedTweets ?? []) {
    if (link.status !== "complete") issues.push(`${link.url}: ${link.error ?? "linked tweet was not captured"}`);
  }
  return [...new Set(issues)];
}

export function finalizeCapture(thread: Thread): CaptureReport {
  const report = thread.capture ??= newCaptureReport(thread);
  const issues = articleIssues(thread, "payload");
  const supplemental = articleIssues(thread, "supplemental");
  if (report.stages.articles.status !== "failed") setStage(thread, "articles", { status: issues.length ? "partial" : "complete", message: issues.length ? issues.join("; ") : "No unresolved author article bodies or assets detected." });
  report.warnings = [...issues, ...supplemental.map((issue) => `Supplemental reply content: ${issue}`)];
  const transcriptTargets = [
    ...(thread.references ?? []).filter((ref) => ref.kind === "video").map((ref) => ({url: ref.url, transcript: ref.transcript})),
    ...(thread.references ?? []).flatMap((ref) => ref.videos ?? []),
    ...allTweets(thread).flatMap((tweet) => tweet.media.filter((media) => media.type === "video").map((media) => ({url: tweet.url, transcript: media.transcript}))),
  ];
  for (const target of transcriptTargets) if (target.transcript?.status !== "complete") report.warnings.push(`Video transcript ${target.transcript?.status ?? "pending"}: ${target.url}${target.transcript?.error ? ` — ${target.transcript.error}` : ""}`);
  for (const tweet of allTweets(thread)) for (const media of tweet.media) if (media.type === "animated_gif") report.warnings.push(`${tweet.id}: animated GIF represented by a poster; no audio transcript applies.`);
  report.stages.transcripts ??= {status: transcriptTargets.length ? "pending" : "complete"};
  const refs = thread.references ?? [];
  const incomplete = refs.filter((ref) => !ref.files.length || ref.status === "partial" || ref.status === "failed" || ref.resolution === "abstract-only" || ref.files.some((file) => file.truncated));
  if (!["skipped", "pending", "failed"].includes(report.stages.references.status)) {
    setStage(thread, "references", { status: incomplete.length ? "partial" : "complete", completed: refs.length - incomplete.length, total: refs.length, message: incomplete.length ? `${incomplete.length} source(s) failed, truncated, or incomplete.` : undefined });
  }
  report.status = Object.values(report.stages).some((stage) => ["pending", "partial", "failed", "skipped"].includes(stage.status)) || report.warnings.length ? "partial" : "complete";
  report.updatedAt = new Date().toISOString();
  return report;
}

export function captureSummary(thread: Thread): string {
  if (!thread.capture) return "Legacy capture: completeness not assessed.";
  return `${thread.capture.status === "complete" ? "Complete" : "Partial"} capture — ` + Object.entries(thread.capture.stages).map(([name, stage]) => `${name}: ${stage.status}${stage.completed != null ? ` (${stage.completed}/${stage.total})` : ""}`).join(", ");
}
