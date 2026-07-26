// What counts as a usable company logo, and how to measure one without decoding it.
//
// This is imported by BOTH the ingestion worker (which decides whether to store a URL) and the
// browser (which decides whether to paint one). That is the entire point of the file: the two used
// to carry the same numbers in two places, and the consequence of them agreeing by coincidence was
// 324,728 stored Workday URLs that the client rejected on sight -- the server had no idea the
// client would throw them away, so it kept writing them.

// A logo is drawn into a 36px square. Much outside this window and it becomes a sliver: a 6:1
// website header banner rendered into a square is roughly six pixels tall, which reads as an empty
// tile rather than as a logo. Measured against production, Workday's constructed /assets/logo is a
// banner at ratios from 1.76 to 6.38.
export const LOGO_MIN_RATIO = 0.625;
export const LOGO_MAX_RATIO = 1.6;

export function isUsableLogoRatio(width, height) {
  if (!width || !height) return false;
  const ratio = width / height;
  return ratio >= LOGO_MIN_RATIO && ratio <= LOGO_MAX_RATIO;
}

// Intrinsic dimensions straight from the file header. Workers have no image decoder and no Node
// image library, but every format below states its size in the first few dozen bytes, so a ranged
// read is enough -- there is never a need to pull down a whole 2MB banner to learn it is a banner.
//
// Returns { width, height, type } or null when the bytes are not a recognisable image (which is
// itself an answer: an HTML error page served with a 200 is not a logo).
//
// `type` matters as much as the size. Workday serves real PNGs with `content-type: text/plain`
// (lowes.wd5's logo is a genuine 134x100 image announced as text), so anything relaying these bytes
// must send the type detected from the FILE, not the one the upstream claimed -- a browser given
// text/plain and nosniff refuses to paint it.
export function imageDimensions(bytes) {
  if (!bytes || bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start, length) =>
    String.fromCharCode(...bytes.subarray(start, start + length));

  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32 at 16 and 20.
  if (bytes[0] === 0x89 && ascii(1, 3) === "PNG") {
    return { width: view.getUint32(16), height: view.getUint32(20), type: "image/png" };
  }

  // GIF: "GIF87a"/"GIF89a", then little-endian uint16 width/height.
  if (ascii(0, 3) === "GIF") {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true), type: "image/gif" };
  }

  // WebP: RIFF container. Three sub-formats, each storing its size differently.
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff, type: "image/webp" };
    }
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: "image/webp" };
    }
    if (chunk === "VP8X") {
      const read24 = (at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
      return { width: read24(24) + 1, height: read24(27) + 1, type: "image/webp" };
    }
    return null;
  }

  // ICO: a directory of entries; the first one's size is enough. 0 encodes 256.
  if (view.getUint16(0, true) === 0 && view.getUint16(2, true) === 1) {
    return { width: bytes[6] || 256, height: bytes[7] || 256, type: "image/x-icon" };
  }

  // JPEG: walk the segment chain to a Start-Of-Frame marker, which is the only place the size
  // lives. Everything before it is metadata of unknown length, so it has to be skipped properly
  // rather than guessed at a fixed offset.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      // SOF0-3, SOF5-7, SOF9-11, SOF13-15 carry dimensions. C4/C8/CC do not -- they are Huffman
      // and arithmetic-coding tables that happen to sit in the same numeric range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7), type: "image/jpeg" };
      }
      offset += 2 + view.getUint16(offset + 2);
    }
    return null;
  }

  // SVG: text, not binary. Prefer the viewBox -- width/height are often "100%" on a logo meant to
  // scale, which says nothing about its shape, while the viewBox always states real proportions.
  const head = ascii(0, Math.min(bytes.length, 1024));
  if (head.includes("<svg")) {
    const viewBox = /viewBox\s*=\s*["']\s*[\d.+-]+[\s,]+[\d.+-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head);
    if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]), type: "image/svg+xml" };
    const width = /\bwidth\s*=\s*["']([\d.]+)/i.exec(head);
    const height = /\bheight\s*=\s*["']([\d.]+)/i.exec(head);
    if (width && height) return { width: Number(width[1]), height: Number(height[1]), type: "image/svg+xml" };
    // A scalable SVG with no stated proportions is assumed square, which is what a logo file with
    // no viewBox almost always is.
    return { width: 1, height: 1, type: "image/svg+xml" };
  }

  return null;
}
