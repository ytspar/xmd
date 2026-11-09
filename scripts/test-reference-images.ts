import "./fixtures/public-dns.js";
/** Run with: pnpm exec tsx scripts/test-reference-images.ts */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { extractWebDocument, hostedVideoUrl } from "../src/web-document.js";
import { downloadReferenceImages, referenceImageKey, canonicalReferenceImageUrl, WEB_IMAGE_DISCOVERY_VERSION } from "../src/reference-images.js";
import type { LinkedReference } from "../src/types.js";
const prose = "An article with substantive diagrams, calculations, responsive evidence and reproducible results. ".repeat(8);
const extracted = extractWebDocument(`<title>Figures</title><header><img src="/logo.png"></header><article><p>${prose}</p>
<figure><picture><source type="image/webp" srcset="/chart-640.webp 640w, /chart-1600.webp 1600w"><img data-src="/chart.png" src="data:image/gif;base64,R0lG" alt="Measured throughput"></picture><figcaption>Figure 1. Throughput by method.</figcaption></figure>
<img src="/placeholder.gif" data-src="/lazy.png" alt="Lazy chart">
<img src="/low.png" data-srcset="/a.png 1x, /b.png 2x" alt="Retina chart">
<img src="/small-logo.png" width="16" height="16" alt="Site logo">
<figure><svg width="200" height="80" aria-label="Inline diagram"><style>.figure { fill: #00f; }</style><rect class="figure" width="200" height="80"/></svg><figcaption>Embedded SVG.</figcaption></figure>
<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>
<video><source src="/talk.mp4"><track src="/talk.vtt" kind="captions" srclang="en"></video>
</article><footer><iframe src="https://vimeo.com/navigation"></iframe></footer>`, "https://publisher.example/post");
assert.equal(extracted.images.length, 4);
assert.equal(extracted.images[0].url, "https://publisher.example/chart-1600.webp");
assert.equal(extracted.images[0].altText, "Measured throughput");
assert.equal(extracted.images[0].caption, "Figure 1. Throughput by method.");
assert.equal(extracted.images[1].url, "https://publisher.example/lazy.png");
assert.equal(extracted.images[2].url, "https://publisher.example/b.png");
assert.match(extracted.images[3].url, /^data:image\/svg\+xml;base64,/);
assert.ok(!extracted.images.some((image) => image.url.endsWith("logo.png")));
for (const image of extracted.images) assert.ok(extracted.text.includes(`[[reference-image:${referenceImageKey(image.url)}]]`));
assert.deepEqual(extracted.videoUrls, ["https://www.youtube.com/watch?v=abcdefghijk", "https://publisher.example/talk.mp4"]);
assert.deepEqual(extracted.videos[1].captionTracks, [{ url: "https://publisher.example/talk.vtt", language: "en", automatic: undefined, format: "vtt" }]);
for (const source of ["https://youtube.com", "https://youtube.com/@creator", "https://youtube.com/channel/UC123",
  "https://youtube.com/embed/videoseries?list=PL123", "https://youtube.com/embed/live_stream?channel=UC123",
  "https://youtube.com/watch?v=short", "https://vimeo.com", "https://vimeo.com/channels/staffpicks", "https://youtube.com/embed/abcdefghijk/nonsense"]) {
  assert.equal(hostedVideoUrl(source), undefined, `Not an actual video: ${source}`);
}
for (const source of ["https://youtube.com/watch?v=abcdefghijk", "https://youtube.com/shorts/abcdefghijk",
  "https://youtube.com/live/abcdefghijk", "https://youtu.be/abcdefghijk?t=3", "https://youtube-nocookie.com/embed/abcdefghijk"]) {
  assert.equal(hostedVideoUrl(source), "https://www.youtube.com/watch?v=abcdefghijk");
}
assert.equal(hostedVideoUrl("https://player.vimeo.com/video/123456"), "https://vimeo.com/123456");
const groupedVideo = extractWebDocument(`<article><p>${prose}</p><a href="https://youtube.com/@creator">Channel</a>
<a href="https://vimeo.com/channels/staffpicks">Vimeo channel</a><a href="https://youtube.com/watch?v=abcdefghijk">Watch</a>
<iframe src="https://youtube.com/embed/abcdefghijk"></iframe>
<video src="/one.mp4"><source src="/alternative.webm"><track src="/en.vtt" srclang="en" kind="subtitles"><track src="/chapters.vtt" kind="chapters"></video></article>`, "https://publisher.example/post");
assert.deepEqual(groupedVideo.videoUrls, ["https://www.youtube.com/watch?v=abcdefghijk", "https://publisher.example/one.mp4"]);
assert.equal(groupedVideo.videos[1].captionTracks?.length, 1);
assert.equal(groupedVideo.videos[1].captionTracks![0].url, "https://publisher.example/en.vtt");
assert.match(groupedVideo.text, /Captions.*en.*https:\/\/publisher.example\/en.vtt/);
assert.equal(canonicalReferenceImageUrl("https://example.com/chart.png?q=2#figure"), "https://example.com/chart.png?q=2");
assert.notEqual(referenceImageKey("https://example.com/chart.png?w=1"), referenceImageKey("https://example.com/chart.png?w=2"));
const commaImage = extractWebDocument(`<article><p>${prose}</p><img srcset="https://cdn.example/w_640,c_limit/chart.png 640w, https://cdn.example/w_1600,c_limit/chart.png 1600w"></article>`, "https://publisher.example/post");
assert.equal(commaImage.images[0].url, "https://cdn.example/w_1600,c_limit/chart.png");

const png = await sharp({ create: { width: 96, height: 64, channels: 4, background: "#f00" } }).png().toBuffer();
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><defs><clipPath id="clip"><rect width="190" height="75"/></clipPath></defs><rect width="200" height="80" fill="blue" clip-path="url(&quot;#clip&quot;)"/></svg>');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tweetmd-reference-images-"));
const originalFetch = globalThis.fetch;
const requests: string[] = [];
const ref = (): LinkedReference => ({ url: "https://publisher.example/post", kind: "web", sourceTweetId: "1", title: "Figures", files: [] });
try {
  globalThis.fetch = async (input) => {
    const url = String(input); requests.push(url);
    if (url.includes("redirect")) return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.png" } });
    if (url.includes("bad")) return new Response("<html>Not an image</html>", { headers: { "content-type": "image/png" } });
    if (url.includes("unsafe")) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><image href="https://private.example/image.png"/></svg>');
    if (url.includes("large")) return new Response(Buffer.alloc(8 * 1024 * 1024 + 1));
    return new Response(url.endsWith(".svg") ? svg : png, { headers: { "content-type": "image/png" } });
  };
  const reference = ref();
  await downloadReferenceImages(reference, dir, { images: [
    { url: "https://cdn.example/chart.png#first", altText: "Evidence" },
    { url: "https://cdn.example/chart.png#second", caption: "Caption" },
    { url: "https://cdn.example/vector.svg" }, ...extracted.images.slice(3),
  ], resume: true });
  assert.equal(reference.media!.length, 3, "Canonical aliases deduplicate");
  assert.equal(reference.imageDiscoveryVersion, WEB_IMAGE_DISCOVERY_VERSION);
  for (const media of reference.media!) {
    assert.ok(media.localPath, media.downloadError);
    assert.equal((await sharp(path.join(dir, media.localPath!)).metadata()).format, "png");
    assert.equal(media.bytes, (await fs.stat(path.join(dir, media.localPath!))).size);
  }
  const inlinePixel = await sharp(path.join(dir, reference.media![2].localPath!)).removeAlpha().raw().toBuffer();
  assert.deepEqual([...inlinePixel.subarray(0, 3)], [0, 0, 255], "Inline SVG styling must survive extraction and rasterization");
  assert.equal(reference.media![0].caption, "Caption");
  reference.media![0].enrichment = { kind: "text", content: "Previously accepted OCR" };
  const bytesBefore = await fs.readFile(path.join(dir, reference.media![0].localPath!));
  requests.length = 0;
  await downloadReferenceImages(reference, dir, { images: [{ url: "https://cdn.example/chart.png#new" }], resume: true });
  assert.equal(requests.length, 0, "Successful immutable source images are reused");
  assert.equal(reference.media![0].enrichment!.content, "Previously accepted OCR");
  assert.deepEqual(await fs.readFile(path.join(dir, reference.media![0].localPath!)), bytesBefore);

  const failure = ref();
  await downloadReferenceImages(failure, dir, { images: ["bad.png", "unsafe.svg", "large.png", "redirect.png"].map((name) => ({ url: `https://cdn.example/${name}` })) });
  assert.ok(failure.media!.every((image) => image.downloadError && !image.localPath));
  assert.match(failure.media![1].downloadError!, /Unsafe SVG/);
  assert.match(failure.media![2].downloadError!, /8 MB/);
  assert.ok(!requests.some((url) => url.startsWith("http://127.0.0.1")), "Redirect guard blocks private targets before fetching");
  const embed=(inner:string)=>`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><image href="data:image/svg+xml;base64,${Buffer.from(inner).toString("base64")}" width="200" height="80"/></svg>`;
  const nested=ref();
  let tooDeep=svg.toString();for(let level=0;level<4;level++)tooDeep=embed(tooDeep);
  await downloadReferenceImages(nested,dir,{images:[embed(svg.toString()),embed('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),tooDeep].map(text=>({url:`data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`}))});
  assert.ok(nested.media![0].localPath,nested.media![0].downloadError);
  assert.match(nested.media![1].downloadError!,/Unsafe SVG/);
  assert.match(nested.media![2].downloadError!,/nesting\/byte limit/);
  const nestedPixel=await sharp(path.join(dir,nested.media![0].localPath!)).removeAlpha().raw().toBuffer();
  assert.deepEqual([...nestedPixel.subarray(0,3)],[0,0,255],"Self-contained badge logos must survive rasterization");
  const embeddedRaster=ref();
  const rasterSvg=`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><image href="data:image/png;base64,${png.toString("base64")}" width="96" height="64"/></svg>`;
  await downloadReferenceImages(embeddedRaster,dir,{images:[{url:`data:image/svg+xml;base64,${Buffer.from(rasterSvg).toString("base64")}`}]});
  assert.ok(embeddedRaster.media![0].localPath,embeddedRaster.media![0].downloadError);
  const rasterPixel=await sharp(path.join(dir,embeddedRaster.media![0].localPath!)).removeAlpha().raw().toBuffer();
  assert.deepEqual([...rasterPixel.subarray(0,3)],[255,0,0]);
  const prefixed=ref();
  await downloadReferenceImages(prefixed,dir,{images:[
    '<?xml-stylesheet type="text/css" href="https://127.0.0.1/private.css"?><svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"/>',
    '<!DOCTYPE svg [<!ENTITY x "unsafe">]><svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"/>'
  ].map(text=>({url:`data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`}))});
  assert.ok(prefixed.media!.every(image=>image.downloadError&&!image.localPath),"XML prefixes must not bypass style/doctype validation");
  assert.match(prefixed.media![0].downloadError!,/not public/);assert.match(prefixed.media![1].downloadError!,/doctype/);

  const bound = ref();
  await downloadReferenceImages(bound, dir, { images: Array.from({ length: 65 }, (_, index) => ({ url: `https://cdn.example/bound-${index}.png` })) });
  assert.equal(bound.media!.filter((image) => image.localPath).length, 64);
  assert.match(bound.media![64].downloadError!, /64 per-source limit/);

  const interrupted = ref();
  const repairUrl = "https://cdn.example/repair.png";
  await fs.writeFile(path.join(dir, "refs", "media", `${referenceImageKey(repairUrl)}.png`), "interrupted");
  await downloadReferenceImages(interrupted, dir, { images: [{ url: repairUrl }], resume: true });
  assert.ok(interrupted.media![0].localPath, interrupted.media![0].downloadError);
  console.log("Article image discovery, guarded download, SVG rasterization, bounds and immutable resume checks passed");
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(dir, { recursive: true, force: true });
}
