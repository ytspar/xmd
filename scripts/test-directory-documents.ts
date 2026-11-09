import "./fixtures/public-dns.js";
/** Directory URLs without a README retain a bounded, honest document snapshot. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fetchReferences, planLink } from "../src/links.js";
import type { Thread } from "../src/types.js";

const originalFetch = globalThis.fetch;
const requests: string[] = [];
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tweetmd-directory-documents-"));
const listing = (root: string, count: number) => Array.from({ length: count }, (_, index) => {
  const name = `child-${String(index).padStart(2, "0")}`;
  return { name, path: `${root}/${name}`, type: "dir" };
});
try {
  globalThis.fetch = async (input) => {
    const url = String(input); requests.push(url);
    if (url === "https://api.github.com/repos/acme/project/contents/examples/plugins?ref=main") return Response.json(listing("examples/plugins", 10));
    const child = url.match(/^https:\/\/api.github.com\/repos\/acme\/project\/contents\/(examples\/plugins\/child-\d+)\?ref=main$/)?.[1];
    if (child) return Response.json([
      { name: "README.md", path: `${child}/README.md`, type: "file" },
      { name: "deep-docs", path: `${child}/deep-docs`, type: "dir" },
    ]);
    if (/^https:\/\/raw.githubusercontent.com\/acme\/project\/main\/examples\/plugins\/child-\d+\/README.md$/.test(url)) return new Response("# Child plugin\n\n![Architecture](diagram.png)");
    if (url === "https://api.github.com/repos/acme/project/contents/docs?ref=main") return Response.json([
      { name: "guide.rst", path: "docs/guide.rst", type: "file" },
      { name: "missing.md", path: "docs/missing.md", type: "file" },
      { name: "implementation.ts", path: "docs/implementation.ts", type: "file" },
    ]);
    if (url === "https://raw.githubusercontent.com/acme/project/main/docs/guide.rst") return new Response("Guide\n=====\n\n.. image:: figure.png");
    if (url === "https://api.github.com/repos/acme/project/contents/provider-blocked?ref=main") return new Response("rate limited", { status: 403 });
    return new Response("Not Found", { status: 404 });
  };
  const thread: Thread = { main: { id: "1", url: "https://x.com/a/status/1", author: { handle: "a", name: "A" },
    text: "https://github.com/acme/project/tree/main/examples/plugins", createdAtRaw: "", metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0 }, media: [], isMainTweet: true },
    ancestors: [], replies: [], capturedAt: "", sourceUrl: "https://x.com/a/status/1" };
  await fetchReferences(thread, dir);
  const reference = thread.references![0];
  assert.equal(reference.status, "partial", "A bounded folder snapshot must not claim full directory completeness");
  assert.equal(reference.files.length, 9, "One index and at most eight nearby source documents");
  assert.equal(reference.media!.length, 8, "Images from all child READMEs are retained");
  assert.match(reference.warning!, /Directory has no README/);
  assert.match(reference.warning!, /Other files and deeper directory content were not captured/);
  const index = await fs.readFile(path.join(dir, reference.files[0].localPath), "utf8");
  assert.match(index, /10 total/);
  assert.match(index, /child-09/);
  assert.ok(reference.files.some((file) => file.finalUrl?.endsWith("child-07/README.md")));
  assert.ok(!requests.some((url) => url.includes("child-08?") || url.includes("child-09?")));
  assert.ok(!requests.some((url) => url.includes("deep-docs?")), "Discovery never recurses beyond one child level");
  assert.ok(!requests.some((url) => url.includes("implementation.ts")));

  const docs = await planLink("https://github.com/acme/project/tree/main/docs")!.fetch();
  assert.equal(docs.length, 2, "Index plus the available document; failed selected file is not invented");
  assert.match(docs[0].metadata!.warning!, /documentation could not be retrieved/);
  assert.match(docs[0].text, /missing.md: listed document could not be retrieved/);
  assert.match(docs[0].text, /## Retrieved documents\n\n- docs\/guide.rst/);
  assert.ok(!requests.some((url) => url.includes("implementation.ts")));
  await assert.rejects(planLink("https://github.com/acme/project/tree/main/absent")!.fetch(), /HTTP 404.*path may be missing or inaccessible/);
  await assert.rejects(planLink("https://github.com/acme/project/tree/main/provider-blocked")!.fetch(), /HTTP 403/);
  console.log("Missing-README directory fallback, child/doc bounds, provenance and missing/provider failures passed");
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(dir, { recursive: true, force: true });
}
