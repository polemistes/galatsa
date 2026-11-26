// SPDX-License-Identifier: GPL-3.0-or-later

// Deterministic randomness and a sample document with one element of every
// planned type, using the provisional data layouts of section 3.4 of
// docs/adr/0001-document-model-and-file-format.md. Used by tests here and in
// other packages.

import * as Y from "yjs";
import type { RandomBytes } from "../model/ids.ts";
import type { RandomSource } from "../model/order.ts";
import { FRAME_TYPE, GROUP_TYPE, type AssetId } from "../model/types.ts";
import {
  addAsset,
  addElement,
  addRoute,
  addStop,
  initDocument,
  insertRouteEntry,
  type OpOptions,
} from "./ops.ts";

/** A small deterministic random number generator (mulberry32). */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic random bytes for ids. */
export function seededBytes(seed: number): RandomBytes {
  const random = seededRandom(seed);
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  };
}

/** Options for deterministic operations. */
export function seededOptions(seed: number): OpOptions {
  return { random: seededRandom(seed), randomBytes: seededBytes(seed + 1) };
}

export const SAMPLE_IMAGE_ASSET: AssetId = `sha256-${"1".repeat(64)}`;
export const SAMPLE_MEDIA_ASSET: AssetId = `sha256-${"2".repeat(64)}`;

/** Element ids of the sample document. */
export const SAMPLE = {
  frame: "frame",
  group: "group",
  text: "text",
  shape: "shape",
  shapeInGroup: "shape2",
  image: "image",
  freehand: "freehand",
  table: "table",
  chart: "chart",
  map: "map",
  media: "media",
  stop1: "stop1",
  stop2: "stop2",
  route1: "route1",
  route2: "route2",
} as const;

/**
 * Builds the sample document: a frame containing a text, a group of two shapes,
 * one element of every other planned type, two stops and two routes that share
 * a stop.
 */
export function buildSampleDocument(doc: Y.Doc = new Y.Doc(), seed = 1): Y.Doc {
  const o = seededOptions(seed);
  initDocument(doc, { id: "sampleDocument", title: "Sample" }, o);
  addElement(
    doc,
    {
      id: SAMPLE.frame,
      type: FRAME_TYPE,
      x: 0,
      y: 0,
      size: { w: 1600, h: 900 },
      name: "Intro",
      data: { clip: false, fill: "#ffffff", stroke: null },
    },
    o,
  );
  addElement(
    doc,
    {
      id: SAMPLE.text,
      type: "galatsa.text/text",
      parent: SAMPLE.frame,
      x: 100,
      y: 100,
      size: { w: 600, h: 80 },
      data: {
        text: {
          $y: "text",
          delta: [
            { insert: "Hello", attributes: { bold: true } },
            { insert: " world\n" },
          ],
        },
        fontFamily: "Inter",
        fontSize: 48,
        color: "#222222",
      },
    },
    o,
  );
  addElement(
    doc,
    {
      id: SAMPLE.shape,
      type: "galatsa.shapes/shape",
      x: 2000,
      y: 0,
      size: { w: 200, h: 100 },
      data: {
        kind: "rectangle",
        fill: "#ff0000",
        stroke: "#000000",
        strokeWidth: 2,
        cornerRadius: 0,
        opacity: 1,
      },
    },
    o,
  );
  addElement(doc, { id: SAMPLE.group, type: GROUP_TYPE, x: 3000, y: 0 }, o);
  addElement(
    doc,
    {
      id: SAMPLE.shapeInGroup,
      type: "galatsa.shapes/shape",
      parent: SAMPLE.group,
      x: 0,
      y: 0,
      size: { w: 50, h: 50 },
      data: { kind: "ellipse", fill: "#00ff00" },
    },
    o,
  );
  addAsset(
    doc,
    SAMPLE_IMAGE_ASSET,
    { mediaType: "image/png", byteLength: 4, width: 1, height: 1, name: "dot.png" },
    o,
  );
  addElement(
    doc,
    {
      id: SAMPLE.image,
      type: "galatsa.image/image",
      x: 0,
      y: 1000,
      size: { w: 400, h: 300 },
      assets: [SAMPLE_IMAGE_ASSET],
      data: { asset: SAMPLE_IMAGE_ASSET, crop: { x: 0, y: 0, w: 1, h: 1 }, opacity: 1 },
    },
    o,
  );
  addElement(
    doc,
    {
      id: SAMPLE.freehand,
      type: "galatsa.freehand/ink",
      x: 500,
      y: 1000,
      size: { w: 100, h: 100 },
      data: {
        strokes: {
          $y: "array",
          items: [{ points: [0, 0, 10, 10], color: "#000000", width: 2 }],
        },
        smoothing: 0.5,
      },
    },
    o,
  );
  addElement(
    doc,
    {
      id: SAMPLE.table,
      type: "galatsa.table/table",
      x: 1000,
      y: 1000,
      size: { w: 300, h: 100 },
      data: {
        rows: { $y: "map", entries: { r1: { order: "a0", size: 30 } } },
        cols: { $y: "map", entries: { c1: { order: "a0", size: 100 } } },
        cells: {
          $y: "map",
          entries: { "r1:c1": { $y: "text", delta: [{ insert: "A1" }] } },
        },
      },
    },
    o,
  );
  addElement(
    doc,
    {
      id: SAMPLE.chart,
      type: "galatsa.chart/chart",
      x: 1500,
      y: 1000,
      size: { w: 400, h: 300 },
      data: {
        kind: "bar",
        options: { legend: true },
        categories: {
          $y: "map",
          entries: {
            c1: { label: "2025", order: "a0" },
            c2: { label: "2026", order: "a1" },
          },
        },
        series: {
          $y: "map",
          entries: {
            s1: {
              $y: "map",
              entries: {
                name: "Sales",
                order: "a0",
                values: { $y: "map", entries: { c1: 1, c2: 2 } },
              },
            },
          },
        },
      },
    },
    o,
  );
  addElement(
    doc,
    {
      id: SAMPLE.map,
      type: "galatsa.map/map",
      x: 2000,
      y: 1000,
      size: { w: 800, h: 600 },
      data: {
        view: { projection: "mercator", center: [10, 60], scale: 1000 },
        features: {
          $y: "map",
          entries: {
            f1: {
              $y: "map",
              entries: {
                kind: "place",
                geometry: { type: "Point", coordinates: [10.75, 59.91] },
                style: { color: "#0000ff" },
                label: { $y: "text", delta: [{ insert: "Oslo" }] },
              },
            },
          },
        },
      },
    },
    o,
  );
  addAsset(doc, SAMPLE_MEDIA_ASSET, { mediaType: "video/mp4", byteLength: 8 }, o);
  addElement(
    doc,
    {
      id: SAMPLE.media,
      type: "galatsa.media/media",
      x: 3000,
      y: 1000,
      size: { w: 640, h: 360 },
      assets: [SAMPLE_MEDIA_ASSET],
      data: {
        asset: SAMPLE_MEDIA_ASSET,
        trim: { start: 0, end: 10 },
        autoplay: false,
        loop: false,
        volume: 1,
      },
    },
    o,
  );

  addStop(
    doc,
    {
      id: SAMPLE.stop1,
      view: { kind: "frame", frame: SAMPLE.frame, padding: 0.05 },
      name: "Intro",
      notes: [{ insert: "Welcome everyone\n" }],
    },
    o,
  );
  addStop(
    doc,
    {
      id: SAMPLE.stop2,
      view: { kind: "rect", space: null, x: 0, y: 1000, w: 1600, h: 900 },
      name: "Details",
    },
    o,
  );
  addRoute(doc, { id: SAMPLE.route1, name: "Full" }, o);
  addRoute(doc, { id: SAMPLE.route2, name: "Short" }, o);
  insertRouteEntry(doc, SAMPLE.route1, SAMPLE.stop1, { ...o, id: "e1" });
  insertRouteEntry(doc, SAMPLE.route1, SAMPLE.stop2, { ...o, id: "e2" });
  insertRouteEntry(doc, SAMPLE.route2, SAMPLE.stop2, { ...o, id: "e3" });
  return doc;
}
