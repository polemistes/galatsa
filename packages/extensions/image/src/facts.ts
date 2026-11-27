// SPDX-License-Identifier: GPL-3.0-or-later

// What an image file is and how large, read from its bytes without decoding
// it: PNG, JPEG (with the EXIF orientation, which turns some photos on their
// side), WebP (lossy, lossless and extended) and SVG. Pure functions with no
// platform APIs, so they run in the importer anywhere.

/** The image formats the extension imports. */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";

export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
];

/** What the bytes say. */
export interface ImageFacts {
  readonly mediaType: ImageMediaType;
  /** Pixel size as the image is shown (EXIF orientation applied); absent if unknown. */
  readonly width?: number;
  readonly height?: number;
}

/** The size of SVG drawn without a size of its own, as browsers draw it. */
export const SVG_DEFAULT_SIZE = { width: 300, height: 150 } as const;

/** The largest side accepted as a size; larger values read as unknown. */
export const MAX_SIDE = 1 << 20;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((b, i) => bytes[at + i] === b);
}

function u16be(b: Uint8Array, at: number): number {
  return ((b[at]! << 8) | b[at + 1]!) >>> 0;
}
function u32be(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}
function u16le(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8)) >>> 0;
}
function u24le(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) >>> 0;
}
function u32le(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
}

function size(width: number, height: number): { width?: number; height?: number } {
  return Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= MAX_SIDE &&
    height <= MAX_SIDE
    ? { width, height }
    : {};
}

/** The bytes as text, for the ASCII parts of SVG: other bytes become "?". */
function ascii(bytes: Uint8Array, limit: number): string {
  let out = "";
  const end = Math.min(bytes.length, limit);
  for (let i = 0; i < end; i++) {
    const b = bytes[i]!;
    out += b < 0x80 ? String.fromCharCode(b) : "?";
  }
  return out;
}

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/**
 * The attributes of the root element of SVG text, after a byte order mark
 * (read as "???"), the XML declaration, comments, processing instructions and
 * a doctype; null if the text does not start with an SVG root element. A
 * single pass with `indexOf`, no regular expression: the time is linear in
 * the text whatever it holds (a pattern with nested repetition took seconds
 * on a few hundred bytes of crafted comments).
 */
export function svgRootAttributes(text: string): Map<string, string> | null {
  let at = text.startsWith("???") ? 3 : 0;
  const skipSpace = (): void => {
    while (isSpace(text[at])) at++;
  };
  for (;;) {
    skipSpace();
    if (text.startsWith("<?", at)) {
      const end = text.indexOf("?>", at + 2);
      if (end < 0) return null;
      at = end + 2;
    } else if (text.startsWith("<!--", at)) {
      const end = text.indexOf("-->", at + 4);
      if (end < 0) return null;
      at = end + 3;
    } else if (text.slice(at, at + 9).toUpperCase() === "<!DOCTYPE") {
      const close = text.indexOf(">", at);
      const open = text.indexOf("[", at);
      if (close < 0) return null;
      if (open >= 0 && open < close) {
        // An internal subset: up to "]", then ">".
        const subset = text.indexOf("]", open);
        if (subset < 0) return null;
        const end = text.indexOf(">", subset);
        if (end < 0) return null;
        at = end + 1;
      } else at = close + 1;
    } else break;
  }
  if (text.slice(at, at + 4).toLowerCase() !== "<svg") return null;
  at += 4;
  const next = text[at];
  if (!isSpace(next) && next !== "/" && next !== ">") return null;
  // Attributes: name, "=", a quoted value; up to ">" or "/>".
  const attributes = new Map<string, string>();
  for (;;) {
    skipSpace();
    const c = text[at];
    if (c === undefined) return null;
    if (c === ">" || c === "/") return attributes;
    const start = at;
    while (at < text.length && !isSpace(text[at]) && !"=/>".includes(text[at]!)) at++;
    const name = text.slice(start, at);
    skipSpace();
    if (text[at] !== "=") {
      if (name === "") return null;
      attributes.set(name, "");
      continue;
    }
    at++;
    skipSpace();
    const quote = text[at];
    if (quote !== '"' && quote !== "'") return null;
    const end = text.indexOf(quote, at + 1);
    if (end < 0) return null;
    if (!attributes.has(name)) attributes.set(name, text.slice(at + 1, end));
    at = end + 1;
  }
}

function isSvgText(text: string): boolean {
  return svgRootAttributes(text) !== null;
}

/** The media type from the first bytes, or null if they are not an image this extension reads. */
export function sniffImage(head: Uint8Array): ImageMediaType | null {
  if (startsWith(head, PNG)) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return "image/webp";
  if (isSvgText(ascii(head, 4096))) return "image/svg+xml";
  return null;
}

/** Width and height swapped for EXIF orientations 5 to 8, which turn the picture a quarter. */
function oriented(width: number, height: number, orientation: number) {
  return orientation >= 5 ? size(height, width) : size(width, height);
}

function pngSize(b: Uint8Array): { width?: number; height?: number } {
  // The IHDR chunk comes first: length, "IHDR", width, height.
  if (b.length < 24 || !startsWith(b, [0x49, 0x48, 0x44, 0x52], 12)) return {};
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  // An eXIf chunk (a TIFF header and its entries) may turn the picture, as
  // browsers apply it; it comes before the image data.
  let orientation = 1;
  for (let at = 8; at + 8 <= b.length;) {
    const length = u32be(b, at);
    const type = ascii(b.subarray(at + 4, at + 8), 4);
    if (type === "IDAT" || type === "IEND") break;
    const body = at + 8;
    const end = Math.min(b.length, body + length);
    if (type === "eXIf") orientation = tiffOrientation(b, body, end);
    at = body + length + 4;
  }
  return oriented(width, height, orientation);
}

/** The orientation (1 to 8) in a TIFF header and its first entries, or 1. */
function tiffOrientation(b: Uint8Array, tiff: number, end: number): number {
  // Some writers keep JPEG's "Exif\0\0" before the TIFF header.
  if (startsWith(b, [0x45, 0x78, 0x69, 0x66, 0, 0], tiff)) tiff += 6;
  if (tiff + 8 > end) return 1;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const big = b[tiff] === 0x4d && b[tiff + 1] === 0x4d;
  if (!little && !big) return 1;
  const r16 = (at: number) => (little ? u16le(b, at) : u16be(b, at));
  const r32 = (at: number) => (little ? u32le(b, at) : u32be(b, at));
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = r16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (r16(entry) === 0x0112) {
      const value = r16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** The EXIF orientation (1 to 8) in a JPEG APP1 segment's payload, or 1. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  // "Exif\0\0", then a TIFF header.
  if (!startsWith(b, [0x45, 0x78, 0x69, 0x66, 0, 0], start)) return 1;
  return tiffOrientation(b, start, end);
}

function jpegSize(b: Uint8Array): { width?: number; height?: number } {
  let at = 2;
  let orientation = 1;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return {};
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return {};
    const length = u16be(b, at + 2);
    if (length < 2) return {};
    const body = at + 4;
    const end = Math.min(b.length, at + 2 + length);
    if (marker === 0xe1)
      orientation = Math.max(orientation, exifOrientation(b, body, end));
    const sof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (sof) {
      if (body + 5 > b.length) return {};
      const height = u16be(b, body + 1);
      const width = u16be(b, body + 3);
      return oriented(width, height, orientation);
    }
    at += 2 + length;
  }
  return {};
}

function webpSize(b: Uint8Array): { width?: number; height?: number } {
  if (b.length < 30) return {};
  const chunk = ascii(b.subarray(12, 16), 4);
  if (chunk === "VP8 ") {
    // A key frame: start code 9d 01 2a, then 14-bit width and height.
    if (!startsWith(b, [0x9d, 0x01, 0x2a], 23)) return {};
    return size(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return {};
    const bits = u32le(b, 21);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  // Browsers do not turn WebP by an EXIF chunk (checked in Chromium and
  // Firefox), so its size is the stored one.
  if (chunk === "VP8X") return size(u24le(b, 24) + 1, u24le(b, 27) + 1);
  return {};
}

const CSS_UNITS: { readonly [unit: string]: number } = {
  "": 1,
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  pt: 96 / 72,
  pc: 16,
};

/**
 * An absolute SVG length in pixels, or undefined (percentages, em, missing).
 * The renderer converts lengths the same way when it draws SVG at a size
 * (`svgAtSize` in @galatsa/renderer); the two must agree.
 */
export function svgLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim().toLowerCase();
  let unitStart = text.length;
  while (unitStart > 0 && text[unitStart - 1]! >= "a" && text[unitStart - 1]! <= "z")
    unitStart--;
  // An exponent ("1e3") is part of the number, not a unit.
  if (unitStart > 0 && text[unitStart] === "e" && unitStart + 1 === text.length)
    return undefined;
  const number = text.slice(0, unitStart).trim();
  const factor = CSS_UNITS[text.slice(unitStart)];
  if (number === "" || factor === undefined || !/^[0-9.e+-]+$/.test(number))
    return undefined;
  const n = Number(number) * factor;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function svgSize(b: Uint8Array): { width?: number; height?: number } {
  const attributes = svgRootAttributes(ascii(b, 1 << 16));
  if (attributes === null) return {};
  let width = svgLength(attributes.get("width"));
  let height = svgLength(attributes.get("height"));
  const box = attributes
    .get("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const boxW = box && box.length === 4 && box[2]! > 0 ? box[2]! : undefined;
  const boxH = box && box.length === 4 && box[3]! > 0 ? box[3]! : undefined;
  if (boxW !== undefined && boxH !== undefined) {
    // A missing side follows the viewBox's proportions.
    if (width === undefined && height === undefined) {
      width = boxW;
      height = boxH;
    } else if (width === undefined) width = (height! * boxW) / boxH;
    else if (height === undefined) height = (width * boxH) / boxW;
  }
  width ??= SVG_DEFAULT_SIZE.width;
  height ??= SVG_DEFAULT_SIZE.height;
  return size(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
}

function extensionType(name: string): ImageMediaType | null {
  const dot = name.lastIndexOf(".");
  const suffix = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  if (suffix === "png") return "image/png";
  if (suffix === "jpg" || suffix === "jpeg") return "image/jpeg";
  if (suffix === "webp") return "image/webp";
  if (suffix === "svg") return "image/svg+xml";
  return null;
}

/**
 * The format and size of an image file. The bytes decide; the name and the
 * reported media type are used only when the bytes do not. Null if it is not
 * an image this extension reads.
 */
export function imageFacts(
  bytes: Uint8Array,
  name = "",
  reported?: string,
): ImageFacts | null {
  const sniffed = sniffImage(bytes.subarray(0, 4096));
  const mediaType =
    sniffed ??
    (IMAGE_MEDIA_TYPES.includes(reported as ImageMediaType)
      ? (reported as ImageMediaType)
      : extensionType(name));
  if (mediaType === null) return null;
  const pixels =
    mediaType === "image/png"
      ? pngSize(bytes)
      : mediaType === "image/jpeg"
        ? jpegSize(bytes)
        : mediaType === "image/webp"
          ? webpSize(bytes)
          : svgSize(bytes);
  return { mediaType, ...pixels };
}
