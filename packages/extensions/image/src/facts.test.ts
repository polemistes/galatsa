// SPDX-License-Identifier: GPL-3.0-or-later

// Reading the format and size of image files from their bytes. The files are
// built here byte by byte: only the headers matter.

import { describe, expect, it } from "vitest";
import { imageFacts, sniffImage, svgLength, svgRootAttributes } from "./facts.ts";

/** ASCII text as bytes (TextEncoder is not in this package's environment). */
const asciiBytes = (text: string): Uint8Array =>
  new Uint8Array([...text].map((c) => c.charCodeAt(0)));

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [
  n >>> 24,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const be16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const le24 = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const le32 = (n: number): number[] => [...le16(n & 0xffff), ...le16(n >>> 16)];

function png(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...ascii("IHDR"),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
  ]);
}

/** A JPEG header: SOI, optionally an EXIF orientation, a comment, then SOF0. */
function jpeg(
  width: number,
  height: number,
  orientation?: number,
  little = false,
): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation !== undefined) {
    const u16 = little ? le16 : be16;
    const u32 = little ? le32 : be32;
    const tiff = [
      ...(little ? ascii("II") : ascii("MM")),
      ...u16(42),
      ...u32(8),
      ...u16(1),
      ...u16(0x0112),
      ...u16(3),
      ...u32(1),
      ...u16(orientation),
      0,
      0,
      ...u32(0),
    ];
    const payload = [...ascii("Exif"), 0, 0, ...tiff];
    parts.push(0xff, 0xe1, ...be16(payload.length + 2), ...payload);
  }
  const comment = ascii("made by hand");
  parts.push(0xff, 0xfe, ...be16(comment.length + 2), ...comment);
  parts.push(0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3);
  parts.push(...new Array(9).fill(0));
  return new Uint8Array(parts);
}

function riff(chunk: string, body: number[]): Uint8Array {
  const data = [...ascii(chunk), ...le32(body.length), ...body];
  return new Uint8Array([
    ...ascii("RIFF"),
    ...le32(data.length + 4),
    ...ascii("WEBP"),
    ...data,
    ...new Array(16).fill(0),
  ]);
}

const svg = (text: string): Uint8Array => asciiBytes(text);

describe("image facts", () => {
  it("reads PNG", () => {
    expect(imageFacts(png(640, 480))).toEqual({
      mediaType: "image/png",
      width: 640,
      height: 480,
    });
  });

  it("reads JPEG, with width and height swapped for photos taken on their side", () => {
    expect(imageFacts(jpeg(4000, 3000))).toEqual({
      mediaType: "image/jpeg",
      width: 4000,
      height: 3000,
    });
    expect(imageFacts(jpeg(4000, 3000, 6))).toMatchObject({ width: 3000, height: 4000 });
    expect(imageFacts(jpeg(4000, 3000, 8, true))).toMatchObject({
      width: 3000,
      height: 4000,
    });
    expect(imageFacts(jpeg(4000, 3000, 3))).toMatchObject({ width: 4000, height: 3000 });
    // Cut off before the frame header: the size is unknown, the type is not.
    expect(imageFacts(jpeg(10, 10).subarray(0, 20))).toEqual({ mediaType: "image/jpeg" });
  });

  it("reads lossy, lossless and extended WebP", () => {
    const vp8 = [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(1920), ...le16(1080), 0, 0];
    expect(imageFacts(riff("VP8 ", vp8))).toEqual({
      mediaType: "image/webp",
      width: 1920,
      height: 1080,
    });
    const bits = (300 - 1) | ((200 - 1) << 14);
    expect(imageFacts(riff("VP8L", [0x2f, ...le32(bits), 0, 0]))).toMatchObject({
      width: 300,
      height: 200,
    });
    expect(
      imageFacts(riff("VP8X", [0x10, 0, 0, 0, ...le24(4095), ...le24(2047)])),
    ).toMatchObject({ width: 4096, height: 2048 });
  });

  it("reads the size of SVG from width and height, the viewBox, or the default", () => {
    expect(
      imageFacts(
        svg('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"/>'),
      ),
    ).toEqual({
      mediaType: "image/svg+xml",
      width: 120,
      height: 80,
    });
    expect(
      imageFacts(
        svg(
          '<?xml version="1.0"?>\n<!-- a comment -->\n<!DOCTYPE svg>\n<svg viewBox="0 0 400 100" xmlns="http://www.w3.org/2000/svg"></svg>',
        ),
      ),
    ).toMatchObject({ width: 400, height: 100 });
    expect(imageFacts(svg("<svg width='2in' viewBox='0 0 10 5'></svg>"))).toMatchObject({
      width: 192,
      height: 96,
    });
    expect(imageFacts(svg('<svg width="100%" height="100%"></svg>'))).toMatchObject({
      width: 300,
      height: 150,
    });
  });

  it("decides by the bytes, then the reported type, then the name", () => {
    expect(imageFacts(png(1, 1), "photo.jpg", "image/jpeg")?.mediaType).toBe("image/png");
    expect(imageFacts(new Uint8Array([1, 2, 3]), "x.webp")).toEqual({
      mediaType: "image/webp",
    });
    expect(imageFacts(new Uint8Array([1, 2, 3]), "x", "image/svg+xml")?.mediaType).toBe(
      "image/svg+xml",
    );
    expect(imageFacts(new Uint8Array([1, 2, 3]), "notes.txt", "text/plain")).toBeNull();
  });

  it("refuses absurd sizes", () => {
    expect(imageFacts(png(0, 10))).toEqual({ mediaType: "image/png" });
    expect(imageFacts(png(2 ** 31, 10))).toEqual({ mediaType: "image/png" });
  });

  it("recognises the formats from the first bytes", () => {
    expect(sniffImage(png(1, 1))).toBe("image/png");
    expect(sniffImage(jpeg(1, 1))).toBe("image/jpeg");
    expect(sniffImage(riff("VP8L", [0x2f, 0, 0, 0, 0]))).toBe("image/webp");
    expect(sniffImage(svg("  <svg>"))).toBe("image/svg+xml");
    expect(sniffImage(svg("<svgfoo>"))).toBeNull();
    expect(sniffImage(svg("<html><svg></svg></html>"))).toBeNull();
  });
});

/** A PNG header with an eXIf chunk (a TIFF header, big endian) of the given orientation. */
function pngWithExif(width: number, height: number, orientation: number): Uint8Array {
  const head = png(width, height);
  const tiff = [
    ...ascii("MM"),
    0,
    42,
    ...be32(8),
    ...be16(1),
    ...be16(0x0112),
    ...be16(3),
    ...be32(1),
    ...be16(orientation),
    0,
    0,
    ...be32(0),
  ];
  // Checksums are not checked when the size is read.
  return new Uint8Array([
    ...head,
    0,
    0,
    0,
    0,
    ...be32(tiff.length),
    ...ascii("eXIf"),
    ...tiff,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...ascii("IDAT"),
  ]);
}

describe("orientation and SVG text", () => {
  it("swaps width and height of a PNG turned a quarter by its eXIf chunk", () => {
    expect(imageFacts(pngWithExif(400, 200, 6))).toMatchObject({
      width: 200,
      height: 400,
    });
    expect(imageFacts(pngWithExif(400, 200, 3))).toMatchObject({
      width: 400,
      height: 200,
    });
  });

  it("finds the SVG root in linear time, however the text before it is made", () => {
    const crafted = "<!---->".repeat(4000) + "x";
    const started = Date.now();
    expect(sniffImage(asciiBytes(crafted.slice(0, 4096)))).toBeNull();
    expect(svgRootAttributes(crafted)).toBeNull();
    expect(svgRootAttributes("<!--" + "-".repeat(60000))).toBeNull();
    expect(svgRootAttributes("<svg " + 'a="'.repeat(20000))).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
    expect(
      svgRootAttributes("<!---->".repeat(100) + '<svg width="3">')?.get("width"),
    ).toBe("3");
  });

  it("reads root attributes, quoted either way, and a doctype with an internal subset", () => {
    const attributes = svgRootAttributes(
      `<?xml version="1.0"?><!DOCTYPE svg [ <!ENTITY a "b"> ]><svg xmlns='x' width = "10" flag height="20"/>`,
    );
    expect(Object.fromEntries(attributes!)).toEqual({
      xmlns: "x",
      width: "10",
      flag: "",
      height: "20",
    });
    expect(svgRootAttributes("<svgx>")).toBeNull();
    expect(svgRootAttributes("<html><svg>")).toBeNull();
  });

  it("converts absolute SVG lengths and leaves others out", () => {
    expect(svgLength("10")).toBe(10);
    expect(svgLength(" 2in ")).toBe(192);
    expect(svgLength("2.54cm")).toBeCloseTo(96, 9);
    expect(svgLength("72pt")).toBeCloseTo(96, 9);
    expect(svgLength("1e2px")).toBe(100);
    expect(svgLength("100%")).toBeUndefined();
    expect(svgLength("2em")).toBeUndefined();
    expect(svgLength("1e")).toBeUndefined();
    expect(svgLength("-5")).toBeUndefined();
    expect(svgLength("1" + "1".repeat(50000) + "x")).toBeUndefined();
  });
});
