/** Normalize pasted prose/Markdown into stable, deduplicated status URLs. */
export function tweetUrls(input: string): string[] {
  const clean = input.replace(/\\([:_/])/g, "$1");
  const urls = new Map<string, string>();
  const pattern = /https?:\/\/(?:www\.)?(?:x\.com|(?:mobile\.)?twitter\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)/gi;
  for (const match of clean.matchAll(pattern)) urls.set(match[2], `https://x.com/${match[1]}/status/${match[2]}`);
  return [...urls.values()];
}
