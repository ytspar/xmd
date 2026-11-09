/**
 * Read pixel dimensions straight from an image file's header bytes — no decode,
 * no dependency. Supports the formats X serves for photos and video/GIF poster
 * frames (PNG, JPEG, GIF, WebP). Returns `null` for anything it can't parse with
 * confidence, so callers should fail OPEN (treat unknown as "enrich it").
 *
 * Used only to cheaply skip enrichment of icon/emoji-sized images — a wrong
 * answer at worst spends or saves one `claude -p` call, never corrupts output.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

export function imageSize(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null;
  return png(buf) ?? gif(buf) ?? jpeg(buf) ?? webp(buf);
}

function png(buf: Buffer): ImageDimensions | null {
  // 8-byte signature, then an IHDR chunk whose width/height are the first two
  // big-endian uint32s of the chunk data (at byte 16 and 20).
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gif(buf: Buffer): ImageDimensions | null {
  const sig = buf.toString("latin1", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  // Logical-screen width/height are little-endian uint16s at byte 6 and 8.
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function jpeg(buf: Buffer): ImageDimensions | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) return null; // not aligned on a marker → give up
    const marker = buf[off + 1];
    // Start-of-frame markers (C0..CF) carry the dimensions, except the four
    // that aren't frame headers: DHT (C4), JPG (C8), DAC (CC), and standalone
    // RST/etc. don't appear here.
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const segLen = buf.readUInt16BE(off + 2);
    if (isSOF) {
      // SOF layout: len(2), precision(1), height(2), width(2).
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    if (segLen < 2) return null; // malformed length would loop forever
    off += 2 + segLen;
  }
  return null;
}

function webp(buf: Buffer): ImageDimensions | null {
  if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") {
    return null;
  }
  const fourcc = buf.toString("latin1", 12, 16);
  if (fourcc === "VP8X") {
    // Extended: canvas width-1 / height-1 as 24-bit little-endian at byte 24/27.
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width: w, height: h };
  }
  if (fourcc === "VP8 ") {
    // Lossy: 14-bit width/height after the 3-byte start code at byte 23.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    // Lossless: 0x2f signature byte, then 14-bit width-1 and height-1 packed LE.
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}
