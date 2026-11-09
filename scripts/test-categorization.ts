/** Deterministic category, proposal and collection checks; no provider/network. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyModelClassification, loadManifest, moveCategoryToCollection, regenerateCategoriesMd, saveManifest, setCategory, setCollections, setTags, type Manifest } from "../src/categorize.js";
import { buildAgentPrompt } from "../src/prompt.js";
import { writeBundle } from "../src/render.js";
import type { Thread } from "../src/types.js";
const thread: Thread = {
  main: { id: "123", url: "https://x.com/test/status/123", author: { name: "Test", handle: "test" },
    text: "A source on search ranking", createdAtRaw: "", media: [], isMainTweet: true,
    metrics: { likes: 0, replies: 0, retweets: 0, quotes: 0 } }, ancestors: [], replies: [],
  capturedAt: "2026-11-04T00:00:00Z", sourceUrl: "https://x.com/test/status/123",
};
const manifest: Manifest = { categories: [{ id: "search", label: "Search", subcategories: [{ id: "ranking", label: "Ranking" }] }], items: [] };
const strong = applyModelClassification(thread, manifest, {
  category: { id: "search" }, subcategory: { id: "ranking" }, confidence: 0.95,
  rationale: "The linked paper evaluates ranking.", tags: ["Retrieval", "retrieval", "AI search"],
}, "fake-model");
assert.equal(strong.category, "search");
assert.equal(strong.subcategory, "ranking");
assert.equal(strong.needsReview, false);
assert.equal(strong.classification!.model, "fake-model");
assert.ok(strong.classification!.taxonomyVersion);
assert.deepEqual(manifest.items[0].tags, ["retrieval", "ai-search"]);
const weak = applyModelClassification(thread, manifest, { category: { id: "other" }, confidence: 0.2, rationale: "Unclear" }, "fake-model");
assert.equal(weak.category, "search", "Weak suggestions must preserve an established assignment");
assert.equal(weak.needsReview, true);
assert.equal(manifest.categories.length, 1, "A model must not expand the taxonomy");
assert.equal(manifest.items[0].proposal!.category.id, "other");
applyModelClassification(thread, manifest, { category: { id: "search" }, subcategory: { id: "new-sub" }, confidence: 1 }, "fake-model");
assert.equal(manifest.categories[0].subcategories!.length, 1);
const empty: Manifest = { categories: [], items: [] };
const proposed = applyModelClassification(thread, empty, { category: { id: "novel" }, confidence: 0.99 }, "fake-model");
assert.equal(proposed.category, "uncategorized");
assert.equal(proposed.needsReview, true);
assert.equal(empty.categories.length, 0);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tweetmd-categories-"));
try {
  await writeBundle(thread, dir);
  await saveManifest(dir, manifest);
  await setCategory(thread, dir, "search");
  await Promise.all([setCollections(thread, dir, ["reading-list"]), setTags(thread, dir, ["retrieval"])]);
  let loaded = await loadManifest(dir);
  assert.equal(loaded.items[0].classification!.method, "manual");
  assert.equal(loaded.items[0].classification!.needsReview, false);
  assert.equal(loaded.items[0].proposal, undefined);
  assert.deepEqual(loaded.items[0].collections, ["reading-list"]);
  assert.deepEqual(loaded.items[0].tags, ["retrieval"]);
  assert.equal((await buildAgentPrompt(dir, ["collection/reading-list"])).count, 1);
  assert.equal((await buildAgentPrompt(dir, ["tag/retrieval"])).count, 1);
  const index = await regenerateCategoriesMd(dir);
  const markdown = await fs.readFile(index.path, "utf8");
  assert.match(markdown, /### General/, "Assignments to a parent with subcategories must remain visible");
  assert.match(markdown, /Collection: reading-list/);
  assert.match(markdown, /\]\(\.\/test_123\/tweet.md\)/);
  assert.doesNotMatch(markdown, /\.\.\/test_123/);
  await setCategory(thread, dir, "legacy-collection");
  await moveCategoryToCollection(dir, "legacy-collection");
  loaded = await loadManifest(dir);
  assert.equal(loaded.items[0].category, "uncategorized");
  assert.ok(loaded.items[0].collections!.includes("legacy-collection"));
  assert.ok(!loaded.categories.some((category) => category.id === "legacy-collection"));
  assert.equal((await buildAgentPrompt(dir, ["legacy-collection"])).count, 1, "Legacy collection references keep working");
  assert.equal((await regenerateCategoriesMd(dir)).uncategorized.length, 1);
  await fs.writeFile(path.join(dir, "categories.json"), "broken JSON");
  await assert.rejects(setCategory(thread, dir, "search"), SyntaxError);
  assert.equal(await fs.readFile(path.join(dir, "categories.json"), "utf8"), "broken JSON", "Never silently replace a damaged manifest");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
console.log("Categorization provenance, proposals, collections and atomic updates passed");
