/** Run: npx tsx scripts/test-svg-styles.ts */
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { JSDOM } from "jsdom";
import { inlineSvgStyles, isPublicStyleAddress, validateSvgFont, type SvgStyleOptions } from "../src/svg-styles.js";
function font(family = "Fixture Font"): Buffer {
  const text = Buffer.from(family, "utf16le").swap16();
  const name = Buffer.alloc(18 + text.length);
  name.writeUInt16BE(1, 2); name.writeUInt16BE(18, 4);
  name.writeUInt16BE(3, 6); name.writeUInt16BE(1, 8); name.writeUInt16BE(0x409, 10); name.writeUInt16BE(1, 12); name.writeUInt16BE(text.length, 14); text.copy(name, 18);
  const bytes = Buffer.alloc(28 + name.length);
  bytes.writeUInt32BE(0x00010000); bytes.writeUInt16BE(1, 4); bytes.write("name", 12); bytes.writeUInt32BE(28, 20); bytes.writeUInt32BE(name.length, 24); name.copy(bytes, 28);
  return bytes;
}
function woff(family = "Fixture Font"): Buffer {
  const sfnt = font(family), name = sfnt.subarray(28), bytes = Buffer.alloc(64 + name.length);
  bytes.write("wOFF"); bytes.writeUInt32BE(0x00010000, 4); bytes.writeUInt32BE(bytes.length, 8); bytes.writeUInt16BE(1, 12); bytes.writeUInt32BE(28 + ((name.length + 3) & ~3), 16);
  bytes.write("name", 44); bytes.writeUInt32BE(64, 48); bytes.writeUInt32BE(name.length, 52); bytes.writeUInt32BE(name.length, 56); name.copy(bytes, 64);
  return bytes;
}
async function withSvg(text: string, check: (doc: Document) => Promise<void>) {
  const dom = new JSDOM(text, { contentType: "image/svg+xml" });
  try { await check(dom.window.document); } finally { dom.window.close(); }
}
const data = `data:application/font-woff;charset=utf-8;base64,${woff().toString("base64")}`;
await withSvg(`<svg xmlns="http://www.w3.org/2000/svg" style="/* fine */ background:#0d1117;font-family:fixture"><style>/* public subset comment */@font-face{font-family:fixture;src:url('${data}') format('woff')}text{font-family:fixture;fill:red;clip-path:url(#clip)}</style><text font-family="fixture,serif">Hello</text></svg>`, async (doc) => {
  const result = await inlineSvgStyles(doc);
  assert.equal(result.fonts.length, 1);
  assert.deepEqual(result.aliases, [{ family: "fixture", actualFamily: "Fixture Font" }]);
  assert.match(result.resources[0].url, /^embedded:font:[a-f0-9]{64}$/);
  assert.doesNotMatch(doc.documentElement.outerHTML, /@font-face|data:application/);
  assert.match(doc.querySelector("text")!.getAttribute("font-family")!, /Fixture Font/);
  assert.match(doc.documentElement.getAttribute("style")!, /Fixture Font/);
  assert.match(doc.querySelector("style")!.textContent!, /Fixture Font/);
});
const calls: string[] = [];
const options: SvgStyleOptions = {
  resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
  fetchResource: async (url) => {
    calls.push(url);
    if (url.endsWith("/entry.css")) return { bytes: Buffer.from('@import "next.css" print; text{fill:blue}'), finalUrl: "https://publisher.example/assets/main.css" };
    if (url.endsWith("/next.css")) return { bytes: Buffer.from('@font-face{font-family:fixture;src:url(font.woff2) format("woff2"),url(font.woff) format("woff")} .a{font-family:fixture}'), finalUrl: url };
    if (url.endsWith("/font.woff")) return { bytes: woff(), finalUrl: url };
    throw new Error(`Unexpected resource ${url}`);
  },
};
await withSvg('<?xml-stylesheet type="text/css" href="entry.css" media="screen"?><svg xmlns="http://www.w3.org/2000/svg"><text font-family="fixture">Hello</text></svg>', async (doc) => {
  const result = await inlineSvgStyles(doc, "https://publisher.example/start.svg", options);
  assert.equal(result.fonts.length, 1);
  assert.equal(result.resources.filter((entry) => entry.kind === "stylesheet").length, 2);
  assert.deepEqual(calls, ["https://publisher.example/entry.css", "https://publisher.example/assets/next.css", "https://publisher.example/assets/font.woff"]);
  assert.match(doc.querySelector("style")!.textContent!, /@media screen.*@media print/);
  const walker = doc.createTreeWalker(doc, 64); assert.equal(walker.nextNode(), null);
});
await withSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>@media screen{@font-face{font-family:fixture;src:url('${data}')}text{font-family:fixture}}</style></svg>`, async (doc) => {
  assert.equal((await inlineSvgStyles(doc)).fonts.length, 1);
  assert.match(doc.querySelector("style")!.textContent!, /@media screen/);
});
for (const css of ['text{fill:url(https://evil.example/image.svg)}', 'text{fill:url(data:image/png;base64,AAAA)}', 'text{behavior:url(#x)}', 'text{fill:expression(alert(1))}', 'text{--hidden:url(https://evil.example/a)}', 'text{fill:var(--hidden)}', 'text{f\\69ll:red}', '@supports(display:block){text{fill:red}}']) {
  await withSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style></svg>`, async (doc) => {
    const previous = doc.documentElement.outerHTML;
    await assert.rejects(inlineSvgStyles(doc, "https://publisher.example/a.svg", options));
    assert.equal(doc.documentElement.outerHTML, previous, "Failure must not leave partially transformed styles");
  });
}
await withSvg('<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://localhost/private.css";</style></svg>', async (doc) => { await assert.rejects(inlineSvgStyles(doc, undefined, options), /not public/); });
await withSvg('<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://publisher.example/private.css";</style></svg>', async (doc) => {
  await assert.rejects(inlineSvgStyles(doc, undefined, { ...options, resolveHost: async () => [{ address: "127.0.0.1", family: 4 }] }), /non-public/);
});
await withSvg('<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://publisher.example/private.css";</style></svg>', async (doc) => {
  await assert.rejects(inlineSvgStyles(doc, undefined, { ...options, fetchResource: async () => ({ bytes: Buffer.from("text{fill:red}"), finalUrl: "https://127.0.0.1/private.css" }) }), /not public/);
});
await withSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{font-family:fixture;src:url('${data}')}text{font:12px fixture}</style></svg>`, async (doc) => { await assert.rejects(inlineSvgStyles(doc), /shorthand/); });
await withSvg('<svg xmlns="http://www.w3.org/2000/svg"><style>text{fill:red}</style></svg>', async (doc) => { await assert.rejects(inlineSvgStyles(doc, undefined, { deadline: Date.now() - 1 }), /deadline/); });
for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "100.64.1.1", "::1", "::ffff:127.0.0.1", "fc00::1", "2001:db8::1", "2001::1", "2001:0000:0:0:0:0:0:1"]) assert.equal(isPublicStyleAddress(address), false, address);
assert.equal(isPublicStyleAddress("93.184.216.34"), true);
assert.equal(isPublicStyleAddress("2606:4700::1111"), true);
validateSvgFont(font()); validateSvgFont(woff());
assert.throws(() => validateSvgFont(Buffer.from("wOF2".padEnd(64, "x"))), /WOFF2/);
assert.throws(() => validateSvgFont(Buffer.alloc(20)), /Unsupported/);
await withSvg('<svg xmlns="http://www.w3.org/2000/svg"><style>@import "a.css";</style></svg>', async (doc) => {
  await assert.rejects(inlineSvgStyles(doc, "https://publisher.example/root.svg", { ...options, fetchResource: async (url) => ({ bytes: Buffer.from(`@import "${url.endsWith("a.css") ? "b" : url.endsWith("b.css") ? "c" : "d"}.css";`), finalUrl: url }) }), /depth|count/);
});
const originalRequest = https.request;
try {
  let lookedUp = 0, pinned = "";
  https.request = ((_url: URL, transport: https.RequestOptions) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    request.destroy = () => {};
    request.end = () => {
      (transport.lookup as Function)("publisher.example", {}, (_error: unknown, address: string) => { pinned = address; });
      queueMicrotask(() => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: object; destroy: () => void };
        response.statusCode = 200; response.headers = {}; response.destroy = () => {};
        request.emit("response", response); response.emit("data", Buffer.from("text{fill:red}")); response.emit("end");
      });
    };
    return request;
  }) as typeof https.request;
  await withSvg('<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://publisher.example/pinned.css";</style></svg>', async (doc) => {
    await inlineSvgStyles(doc, undefined, { resolveHost: async () => { lookedUp++; return [{ address: "93.184.216.34", family: 4 }]; } });
  });
  assert.equal(lookedUp, 1, "HTTPS transport must not perform a second, rebinding-prone lookup");
  assert.equal(pinned, "93.184.216.34");
} finally { https.request = originalRequest; }
console.log("SVG visual CSS, fonts, aliases, imports, resource guards and limits passed");
