#!/usr/bin/env tsx
/**
 * Renders a compiled research digest (e.g. "all our tweets on X") into a
 * consistent Markdown file under reports/. Content/sections are supplied by
 * whoever is compiling the report (a Claude session reading captures) — this
 * script only owns the consistent shape: frontmatter, dek, body, sources.
 *
 * Usage: tsx scripts/generate-report.ts --config <path-to-json>
 *
 * Config JSON shape:
 * {
 *   "slug": "topic-summary",
 *   "title": "Topic Summary",
 *   "dek": "One or two sentences describing the report.",
 *   "compiledAt": "2026-07-12",
 *   "body": "## Section\n\nMarkdown body content, already written out.",
 *   "sources": [
 *     { "handle": "example", "date": "2026-07-11", "url": "https://x.com/example/status/...", "note": "Summary of the source" }
 *   ]
 * }
 */
import fs from "node:fs/promises";
import path from "node:path";

interface Source {
  handle: string;
  date: string;
  url: string;
  note?: string;
}

interface ReportConfig {
  slug: string;
  title: string;
  dek?: string;
  compiledAt?: string;
  body: string;
  sources: Source[];
}

function parseArgs(argv: string[]): { config?: string } {
  const args: { config?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") args.config = argv[++i];
  }
  return args;
}

function renderFrontmatter({ title, compiledAt, sources }: ReportConfig): string {
  const lines = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `compiled_at: ${JSON.stringify(compiledAt)}`,
    `source_count: ${sources.length}`,
    "---",
    "",
    "",
  ];
  return lines.join("\n");
}

function renderSources(sources: Source[]): string {
  if (!sources.length) return "";
  const rows = sources.map(
    (s) => `- **@${s.handle}** · ${s.date}${s.note ? ` — ${s.note}` : ""} — [${s.url}](${s.url})`,
  );
  return `\n## Sources\n\n${rows.join("\n")}\n`;
}

async function main(): Promise<void> {
  const { config } = parseArgs(process.argv.slice(2));
  if (!config) {
    console.error("Usage: tsx scripts/generate-report.ts --config <path-to-json>");
    process.exitCode = 1;
    return;
  }
  const raw = await fs.readFile(path.resolve(config), "utf8");
  const cfg = JSON.parse(raw) as ReportConfig;
  if (!cfg.slug || !cfg.title || !cfg.body || !Array.isArray(cfg.sources)) {
    console.error("Config must include slug, title, body, and sources[].");
    process.exitCode = 1;
    return;
  }

  const reportsDir = path.resolve(import.meta.dirname, "..", "reports");
  await fs.mkdir(reportsDir, { recursive: true });

  const out =
    renderFrontmatter(cfg) +
    `# ${cfg.title}\n\n` +
    (cfg.dek ? `*${cfg.dek}*\n\n` : "") +
    cfg.body.trim() +
    "\n" +
    renderSources(cfg.sources) +
    `\n---\n\nCompiled from local \`xmd\` captures under \`~/.tweetmd/out\`. Model names, benchmark numbers, and cost claims are as reported by the tweet authors — not independently verified.\n`;

  const outPath = path.join(reportsDir, `${cfg.slug}.md`);
  await fs.writeFile(outPath, out, "utf8");
  console.log(outPath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
