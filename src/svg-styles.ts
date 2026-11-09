/** Resolve a bounded visual-only SVG stylesheet graph before offline rasterization. */
import * as css from "css-tree";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicAddress as isPublicStyleAddress } from "./public-network.js";
import { createHash } from "node:crypto";
import { svgFontFamilyNames } from "./svg-fonts.js";

export interface SvgStyleResource { url: string; bytes: number; kind: "stylesheet" | "font" }
export interface SvgStyleResult { fonts: Buffer[]; resources: SvgStyleResource[]; aliases?: { family: string; actualFamily: string }[] }
export interface SvgStyleOptions {
  /** Nested SVGs share the root resource deadline rather than resetting it. */
  deadline?: number;
  /** Tests may replace transport; production never delegates fetches to a rasterizer. */
  fetchResource?: (url: string, maximum: number, deadline: number) => Promise<{ bytes: Buffer; finalUrl: string }>;
  resolveHost?: (host: string) => Promise<{ address: string; family: number }[]>;
}
const MAX_CSS = 256 * 1024, MAX_FONT = 2 * 1024 * 1024, MAX_TOTAL = 4 * 1024 * 1024;
const VISUAL_PROPERTIES = new Set(("background background-color alignment-baseline baseline-shift clip clip-path clip-rule color color-interpolation color-interpolation-filters color-rendering direction display dominant-baseline fill fill-opacity fill-rule filter flood-color flood-opacity font font-family font-size font-size-adjust font-stretch font-style font-variant font-weight font-feature-settings font-kerning glyph-orientation-horizontal glyph-orientation-vertical image-rendering isolation letter-spacing lighting-color line-height marker marker-end marker-mid marker-start mask mix-blend-mode opacity overflow paint-order shape-rendering stop-color stop-opacity stroke stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-decoration-color text-decoration-line text-decoration-style text-rendering text-transform transform transform-box transform-origin unicode-bidi vector-effect visibility white-space word-spacing writing-mode cx cy r rx ry x y d width height").split(" "));
const VISUAL_FUNCTIONS = new Set("rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix calc min max clamp matrix matrix3d translate translatex translatey translatez translate3d scale scalex scaley scalez scale3d rotate rotatex rotatey rotatez rotate3d skew skewx skewy perspective cubic-bezier steps".split(" "));

export { isPublicAddress as isPublicStyleAddress } from "./public-network.js";
function publicUrl(input: string, base?: string): URL {
  const url = new URL(input, base);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("SVG stylesheet/font resources require public HTTPS URLs without credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(?:localhost|local|internal)$/i.test(host) || (isIP(host) && !isPublicStyleAddress(host))) throw new Error("SVG resource address is not public.");
  url.hash = "";
  return url;
}
async function addresses(url: URL, deadline: number, resolveHost: NonNullable<SvgStyleOptions["resolveHost"]>): Promise<{ address: string; family: number }[]> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  if (literal) return [{ address: host, family: literal }];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolved = await Promise.race([resolveHost(host), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("SVG resource DNS lookup timed out.")), Math.max(1, deadline - Date.now())); })]);
    if (!resolved.length || resolved.some((answer) => !isPublicStyleAddress(answer.address))) throw new Error("SVG resource DNS includes a non-public address.");
    return resolved;
  } finally { if (timer) clearTimeout(timer); }
}
async function fetchPinned(input: string, maximum: number, deadline: number, resolveHost: NonNullable<SvgStyleOptions["resolveHost"]>): Promise<{ bytes: Buffer; finalUrl: string }> {
  let url = publicUrl(input);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (Date.now() >= deadline) throw new Error("SVG stylesheet/font deadline exceeded.");
    const selected = (await addresses(url, deadline, resolveHost))[0];
    const response = await new Promise<{ bytes?: Buffer; location?: string }>((resolve, reject) => {
      let settled = false;
      const request = https.request(url, {
        method: "GET", headers: { accept: "text/css,font/woff,font/ttf,font/otf,application/octet-stream", "user-agent": "xmd/0.1" },
        lookup: ((_host: string, options: unknown, callback: (...args: unknown[]) => void) => {
          if (typeof options === "object" && options !== null && "all" in options && options.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        }) as NonNullable<https.RequestOptions["lookup"]>,
      });
      const timer = setTimeout(() => finish(new Error("SVG resource request timed out.")), Math.max(1, deadline - Date.now()));
      const finish = (error?: Error, value?: { bytes?: Buffer; location?: string }) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { request.destroy(); reject(error); } else resolve(value!);
      };
      request.on("error", (error) => finish(error));
      request.on("response", (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          const location = res.headers.location;
          res.destroy();
          if (!location) finish(new Error("SVG resource redirect has no target.")); else finish(undefined, { location });
          return;
        }
        if (res.statusCode !== 200) { res.destroy(); finish(new Error(`SVG resource returned HTTP ${res.statusCode}.`)); return; }
        if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") { res.destroy(); finish(new Error("Compressed SVG resource responses are unsupported.")); return; }
        const chunks: Buffer[] = []; let total = 0;
        res.on("data", (chunk: Buffer) => { total += chunk.length; if (total > maximum) { res.destroy(); finish(new Error("SVG resource exceeds byte limit.")); } else chunks.push(chunk); });
        res.on("error", (error) => finish(error));
        res.on("end", () => finish(undefined, { bytes: Buffer.concat(chunks) }));
      });
      request.end();
    });
    if (response.location) { url = publicUrl(response.location, url.href); continue; }
    return { bytes: response.bytes!, finalUrl: url.href };
  }
  throw new Error("SVG resource redirect limit exceeded.");
}
/** Magic and table bounds checked before fonts reach the rendering/font decoder. */
export function validateSvgFont(bytes: Buffer): void {
  if (bytes.length > MAX_FONT || bytes.length < 12) throw new Error("SVG font exceeds size limit or is truncated.");
  const magic = bytes.toString("ascii", 0, 4);
  if (magic === "wOF2") throw new Error("WOFF2 SVG fonts are unsupported; use WOFF1, TTF or OTF.");
  if (magic === "wOFF") {
    if (bytes.length < 44 || bytes.readUInt32BE(8) !== bytes.length || bytes.readUInt16BE(14) !== 0) throw new Error("Invalid WOFF1 font header.");
    const count = bytes.readUInt16BE(12);
    if (!count || count > 128 || 44 + count * 20 > bytes.length || bytes.readUInt32BE(16) > 4 * 1024 * 1024) throw new Error("Invalid WOFF1 font table bounds.");
    for (let i = 0; i < count; i++) {
      const entry = 44 + i * 20, offset = bytes.readUInt32BE(entry + 4), length = bytes.readUInt32BE(entry + 8), original = bytes.readUInt32BE(entry + 12);
      if (offset < 44 + count * 20 || offset + length > bytes.length || !length || length > original || original > MAX_FONT) throw new Error("Invalid WOFF1 font table range.");
    }
    return;
  }
  if (magic !== "OTTO" && bytes.readUInt32BE(0) !== 0x00010000) throw new Error("Unsupported SVG font magic; expected WOFF1, TTF or OTF.");
  const count = bytes.readUInt16BE(4);
  if (!count || count > 128 || 12 + count * 16 > bytes.length) throw new Error("Invalid SFNT font table bounds.");
  for (let i = 0; i < count; i++) {
    const entry = 12 + i * 16, offset = bytes.readUInt32BE(entry + 8), length = bytes.readUInt32BE(entry + 12);
    if (offset < 12 + count * 16 || offset + length > bytes.length) throw new Error("Invalid SFNT font table range.");
  }
}
function cssAst(source: string): css.StyleSheet {
  if (/\\|<\s*\/?\s*script|expression\s*\(|javascript\s*:/i.test(source)) throw new Error("Unsafe or obfuscated SVG stylesheet syntax.");
  let invalid = false;
  const ast = css.parse(source, { positions: false, onParseError: () => { invalid = true; } });
  css.walk(ast, (node) => { if (node.type === "Raw") invalid = true; });
  if (invalid || ast.type !== "StyleSheet") throw new Error("Unsupported or malformed SVG stylesheet.");
  return ast;
}
function validateVisual(ast: css.CssNode): void {
  css.walk(ast, (node) => {
    if (node.type === "Atrule" && node.name.toLowerCase() !== "media") throw new Error(`Unsupported SVG CSS @${node.name}.`);
    if (node.type === "Declaration" && !VISUAL_PROPERTIES.has(node.property.toLowerCase())) throw new Error(`Unsupported SVG visual CSS property: ${node.property}.`);
    if (node.type === "Function" && !VISUAL_FUNCTIONS.has(node.name.toLowerCase())) throw new Error(`Unsupported SVG CSS function: ${node.name}.`);
    if (node.type === "Url" && !/^#[A-Za-z_][\w:.-]*$/.test(node.value)) throw new Error("SVG visual CSS may reference local fragments only.");
    if (node.type === "Raw") throw new Error("Unparsed SVG CSS is not allowed.");
  });
}
function dataFont(value: string): Buffer {
  const match = value.match(/^data:(?:font\/(?:woff|ttf|otf)|application\/(?:font-woff|x-font-ttf|x-font-opentype|vnd\.ms-opentype|octet-stream))(?:;charset=[A-Za-z0-9_-]+)?;base64,([A-Za-z0-9+/]*={0,2})$/i);
  if (!match || !match[1] || match[1].length % 4 || match[1].length > Math.ceil(MAX_FONT / 3) * 4) throw new Error("Unsupported or oversized SVG embedded font URL.");
  const bytes = Buffer.from(match[1], "base64");
  validateSvgFont(bytes);
  return bytes;
}

/** Mutates styles only after the whole stylesheet/font graph is validated. */
export async function inlineSvgStyles(document: Document, baseUrl?: string, opts: SvgStyleOptions = {}): Promise<SvgStyleResult> {
  const result: SvgStyleResult = { fonts: [], resources: [], aliases: [] };
  const aliases = new Map<string, string>();
  const deadline = Math.min(opts.deadline ?? Infinity, Date.now() + 20_000);
  const resolveHost = opts.resolveHost ?? ((host: string) => lookup(host, { all: true }));
  let cssBytes = 0, resourceBytes = 0, styleCount = 0;
  const fontHashes = new Set<string>(), imported = new Set<string>();
  const countCss = (value: string) => { cssBytes += Buffer.byteLength(value); if (cssBytes > MAX_CSS) throw new Error("SVG styles exceed total CSS limit."); };
  const fetchResource = async (input: string, maximum: number) => {
    const url = publicUrl(input);
    if (Date.now() >= deadline) throw new Error("SVG stylesheet/font deadline exceeded.");
    // Transport injection still receives a validated target and public DNS check.
    if (opts.fetchResource) await addresses(url, deadline, resolveHost);
    const response = await (opts.fetchResource ? opts.fetchResource(url.href, maximum, deadline) : fetchPinned(url.href, maximum, deadline, resolveHost));
    publicUrl(response.finalUrl);
    if (opts.fetchResource) await addresses(publicUrl(response.finalUrl), deadline, resolveHost);
    if (Date.now() >= deadline || response.bytes.length > maximum) throw new Error("SVG resource exceeds time/byte limit.");
    resourceBytes += response.bytes.length;
    if (resourceBytes > MAX_TOTAL) throw new Error("SVG stylesheet/font resources exceed total byte limit.");
    return response;
  };
  const addFont = (bytes: Buffer, url: string, family: string) => {
    validateSvgFont(bytes);
    const names = svgFontFamilyNames(bytes);
    if (!names.length) throw new Error("SVG font lacks verifiable internal family names.");
    const actualFamily = names.find((name) => name.toLowerCase() === family.toLowerCase()) ?? names[0];
    if (/[\x00-\x1f"\\]/.test(actualFamily)) throw new Error("Unsupported characters in SVG internal font family.");
    const normalized = family.trim().replace(/\s+/g, " ").toLowerCase();
    const previous = aliases.get(normalized);
    if (previous && previous !== actualFamily) throw new Error("Conflicting SVG font-family alias definitions.");
    aliases.set(normalized, actualFamily);
    if (family !== actualFamily && !result.aliases!.some((alias) => alias.family === family)) result.aliases!.push({ family, actualFamily });
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (fontHashes.has(hash)) return;
    if (result.fonts.length >= 8) throw new Error("SVG font count exceeds eight.");
    fontHashes.add(hash); result.fonts.push(bytes); result.resources.push({ url: url.startsWith("data:") ? `embedded:font:${hash}` : url, bytes: bytes.length, kind: "font" });
  };
  const process = async (source: string, base: string | undefined, depth: number): Promise<string> => {
    if (Date.now() >= deadline || depth > 2) throw new Error("SVG stylesheet import depth/deadline exceeded.");
    if (++styleCount > 4) throw new Error("SVG stylesheet count exceeds four.");
    countCss(source);
    const ast = cssAst(source);
    const transform = async (nodes: css.List<css.CssNode>): Promise<string> => {
    const output: string[] = [];
    for (const node of nodes) {
      if (Date.now() >= deadline) throw new Error("SVG stylesheet/font deadline exceeded.");
      if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
        if (!node.prelude || node.block) throw new Error("Malformed SVG CSS import.");
        const children = node.prelude.type === "AtrulePrelude" ? node.prelude.children.toArray() : [];
        const target = children[0];
        if (!target || !["Url", "String"].includes(target.type)) throw new Error("Unsupported SVG CSS import target.");
        const value = target.type === "Url" || target.type === "String" ? target.value : "";
        const url = publicUrl(value, base).href;
        if (imported.has(url)) throw new Error("Cyclic or duplicate SVG stylesheet import.");
        imported.add(url);
        const fetched = await fetchResource(url, MAX_CSS - cssBytes);
        result.resources.push({ url: fetched.finalUrl, bytes: fetched.bytes.length, kind: "stylesheet" });
        const nested = await process(fetched.bytes.toString("utf8"), fetched.finalUrl, depth + 1);
        const remaining = children.slice(1);
        if (remaining.some((part) => part.type !== "MediaQueryList")) throw new Error("Unsupported SVG import condition.");
        output.push(remaining.length ? `@media ${remaining.map((part) => css.generate(part)).join(" ")}{${nested}}` : nested);
      } else if (node.type === "Atrule" && node.name.toLowerCase() === "font-face") {
        if (!node.block || node.prelude) throw new Error("Malformed SVG font-face rule.");
        const familyDeclaration = node.block.children.toArray().find((part) => part.type === "Declaration" && part.property.toLowerCase() === "font-family");
        if (!familyDeclaration || familyDeclaration.type !== "Declaration" || familyDeclaration.value.type !== "Value") throw new Error("SVG font-face requires a literal font-family.");
        const familyParts = familyDeclaration.value.children.toArray();
        if (!familyParts.length || familyParts.some((part) => !["String", "Identifier"].includes(part.type))) throw new Error("Unsupported SVG font-family expression.");
        const family = familyParts.map((part) => part.type === "String" ? part.value : part.type === "Identifier" ? part.name : "").join(" ");
        let sourceFound = false, lastError = "SVG font-face lacks a supported font URL.";
        const candidates: string[] = [];
        for (const declaration of node.block.children) {
          if (declaration.type !== "Declaration" || !["font-family", "src", "font-style", "font-weight", "font-stretch", "unicode-range", "font-display"].includes(declaration.property.toLowerCase())) throw new Error("Unsupported SVG font-face declaration.");
          if (declaration.property.toLowerCase() !== "src") {
            css.walk(declaration.value, (part) => { if (part.type === "Url" || part.type === "Raw" || part.type === "Function") throw new Error("Unsupported SVG font-face descriptor resource/expression."); });
            continue;
          }
          css.walk(declaration.value, (part) => { if (part.type === "Function" && !["format", "local"].includes(part.name.toLowerCase())) throw new Error("Unsafe SVG font source function."); if (part.type === "Raw") throw new Error("Unparsed SVG font source."); });
          css.walk(declaration.value, (part) => { if (part.type === "Url") candidates.push(part.value); });
        }
        for (const value of candidates.slice(0, 3)) {
          try {
            if (/^data:[^,]*woff2[;,]/i.test(value) || /\.woff2(?:[?#]|$)/i.test(value)) throw new Error("WOFF2 SVG fonts are unsupported.");
            if (value.startsWith("data:")) {
              const bytes = dataFont(value); resourceBytes += bytes.length;
              if (resourceBytes > MAX_TOTAL) throw new Error("SVG font resources exceed total byte limit.");
              addFont(bytes, value, family);
            } else {
              const fetched = await fetchResource(publicUrl(value, base).href, MAX_FONT);
              addFont(fetched.bytes, fetched.finalUrl, family);
            }
            sourceFound = true; break;
          } catch (error) { lastError = (error as Error).message; }
        }
        if (!sourceFound) throw new Error(lastError);
      } else if (node.type === "Atrule" && node.name.toLowerCase() === "media") {
        if (!node.prelude || !node.block) throw new Error("Malformed SVG CSS media block.");
        validateVisual(node.prelude);
        output.push(`@media ${css.generate(node.prelude)}{${await transform(node.block.children)}}`);
      } else {
        validateVisual(node);
        output.push(css.generate(node));
      }
    }
    return output.join("\n");
    };
    const combined = await transform(ast.children);
    // Verify the generated graph has no fetching constructs left.
    validateVisual(cssAst(combined));
    return combined;
  };
  const replacements: { element: Element; text: string }[] = [];
  const pis: ProcessingInstruction[] = [];
  const walker = document.createTreeWalker(document, 64);
  while (walker.nextNode()) {
    const pi = walker.currentNode as ProcessingInstruction;
    if (pi.target !== "xml-stylesheet") continue;
    const attrs = new Map([...pi.data.matchAll(/([A-Za-z-]+)\s*=\s*(["'])(.*?)\2/g)].map((match) => [match[1].toLowerCase(), match[3]]));
    const stripped = pi.data.replace(/([A-Za-z-]+)\s*=\s*(["'])(.*?)\2/g, "").trim();
    if (stripped || !attrs.get("href") || (attrs.has("type") && attrs.get("type") !== "text/css") || (attrs.has("alternate") && attrs.get("alternate") !== "no")) throw new Error("Unsupported SVG xml-stylesheet processing instruction.");
    const fetched = await fetchResource(publicUrl(attrs.get("href")!, baseUrl).href, MAX_CSS - cssBytes);
    result.resources.push({ url: fetched.finalUrl, bytes: fetched.bytes.length, kind: "stylesheet" });
    let text = await process(fetched.bytes.toString("utf8"), fetched.finalUrl, 0);
    if (attrs.get("media")) {
      text = `@media ${attrs.get("media")}{${text}}`;
      validateVisual(cssAst(text));
    }
    const element = document.createElementNS("http://www.w3.org/2000/svg", "style");
    replacements.push({ element, text }); pis.push(pi);
  }
  for (const element of document.querySelectorAll("style")) {
    if (element.getAttribute("type") && element.getAttribute("type") !== "text/css") throw new Error("Unsupported SVG stylesheet type.");
    replacements.push({ element, text: await process(element.textContent ?? "", baseUrl, 0) });
  }
  const rewriteFamilyValue = (value: css.CssNode): css.Value => {
    if (value.type !== "Value") throw new Error("Unsupported SVG font-family value.");
    const groups: css.CssNode[][] = [[]];
    for (const part of value.children) {
      if (part.type === "Operator" && part.value === ",") groups.push([]);
      else groups[groups.length - 1].push(part);
    }
    const generated = groups.map((parts) => {
      if (!parts.length || parts.some((part) => !["String", "Identifier"].includes(part.type))) throw new Error("Unsupported SVG font-family expression.");
      const name = parts.map((part) => part.type === "String" ? part.value : part.type === "Identifier" ? part.name : "").join(" ");
      const actual = aliases.get(name.trim().replace(/\s+/g, " ").toLowerCase());
      return actual ? JSON.stringify(actual) : parts.map((part) => css.generate(part)).join(" ");
    }).join(",");
    const parsed = css.parse(generated, { context: "value" });
    if (parsed.type !== "Value") throw new Error("Invalid SVG font-family replacement.");
    return parsed;
  };
  const rewriteDeclarations = (ast: css.CssNode): void => {
    css.walk(ast, (node) => {
      if (node.type !== "Declaration") return;
      if (node.property.toLowerCase() === "font-family") node.value = rewriteFamilyValue(node.value);
      else if (node.property.toLowerCase() === "font" && aliases.size) throw new Error("SVG font shorthand with embedded fonts is unsupported; use font-family explicitly.");
    });
  };
  for (const replacement of replacements) {
    const ast = cssAst(replacement.text); rewriteDeclarations(ast); replacement.text = css.generate(ast);
  }
  // Inline attributes never gain network capability; stage all changes before mutation.
  const attributes: { element: Element; name: string; value: string }[] = [];
  for (const element of document.querySelectorAll("[style]")) {
    const value = element.getAttribute("style") ?? "";
    if (/\\/.test(value)) throw new Error("Unsafe SVG inline CSS syntax.");
    let invalid = false;
    const ast = css.parse(value, { context: "declarationList", onParseError: () => { invalid = true; } });
    if (invalid) throw new Error("Malformed SVG inline CSS.");
    validateVisual(ast); rewriteDeclarations(ast);
    attributes.push({ element, name: "style", value: css.generate(ast) });
  }
  for (const element of document.querySelectorAll("[font-family]")) {
    const value = element.getAttribute("font-family") ?? "";
    if (/\\/.test(value)) throw new Error("Unsafe SVG font-family attribute.");
    attributes.push({ element, name: "font-family", value: css.generate(rewriteFamilyValue(css.parse(value, { context: "value" }))) });
  }
  const firstChild = document.documentElement.firstChild;
  for (const { element, text } of replacements) {
    element.textContent = text;
    if (!element.parentNode) document.documentElement.insertBefore(element, firstChild);
  }
  for (const attribute of attributes) attribute.element.setAttribute(attribute.name, attribute.value);
  for (const pi of pis) pi.remove();
  return result;
}
