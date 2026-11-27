// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/extension-image/view: the viewing part of the image extension, what
// the renderer and the player need to draw images. An image element refers to
// an asset (the bytes live in the asset store, with reduced versions made when
// the image was added; the document holds the asset's description), shows all
// of it or a cropped part, stretched to the element's box. Nothing reachable
// from here imports editing code, Yjs or the document's operations. See
// docs/adr/0012-images-and-assets.md.

import {
  ASSET_ID_PATTERN,
  type AssetId,
  type ElementData,
  type Rect,
} from "@galatsa/core";
import {
  EXTENSION_API_VERSION,
  defineElementView,
  defineViewExtension,
  messageKey,
  type DataReport,
  type ImageState,
  type Label,
} from "@galatsa/extension-api";
import type { BundleKey } from "@galatsa/i18n";
import { imageMessages } from "./messages/index.ts";

export { imageMessages } from "./messages/index.ts";
export * from "./facts.ts";

export const IMAGE_EXTENSION = "galatsa.image";
export const IMAGE_TYPE = `${IMAGE_EXTENSION}/image`;

export function imageLabel(key: BundleKey<typeof imageMessages>): Label {
  return messageKey(imageMessages, key);
}

/**
 * An image element's data, layout version 1 (part of the file format; every
 * key is optional when read, and a missing key means its default forever):
 *
 * - `asset`: the asset id of the image file; none (drawn as "missing") if absent.
 * - `crop`: the part of the image shown, `{x, y, w, h}` in the pixels of the
 *   image at its natural size (the asset description's width and height), or
 *   null for all of it. Default null.
 * - `opacity`: 0 (invisible) to 1. Default 1.
 */
export interface ImageModel {
  readonly asset: AssetId | null;
  readonly crop: Rect | null;
  readonly opacity: number;
}

export const DEFAULT_OPACITY = 1;

/** A rectangle with finite numbers and a positive width and height. */
export function isCropRect(value: unknown): value is Rect {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    ["x", "y", "w", "h"].every(
      (k) => typeof r[k] === "number" && Number.isFinite(r[k]),
    ) &&
    (r["w"] as number) > 0 &&
    (r["h"] as number) > 0
  );
}

function own(data: ElementData, key: string): unknown {
  return Object.hasOwn(data, key) ? data[key] : undefined;
}

/**
 * Reads an image's data. Total. A crop rectangle that reaches outside the
 * image (a later version may allow that, or the image's description may have
 * changed) is kept and drawn clipped to the image, without a report; an
 * opacity outside 0 to 1 is drawn as the nearest value in range (lenient for
 * growth, docs/adr/0005 section 3.2). Values of the wrong form are reported.
 */
export function readImage(data: ElementData, report: DataReport): ImageModel {
  const asset = own(data, "asset");
  const isAsset = typeof asset === "string" && ASSET_ID_PATTERN.test(asset);
  if (asset !== undefined && !isAsset)
    report("asset", "must be an asset id, read as none");
  const crop = own(data, "crop");
  if (crop !== undefined && crop !== null && !isCropRect(crop))
    report("crop", "must be a rectangle with a positive size or null, read as null");
  const opacity = own(data, "opacity");
  let alpha = DEFAULT_OPACITY;
  if (typeof opacity === "number" && Number.isFinite(opacity))
    alpha = Math.min(1, Math.max(0, opacity));
  else if (opacity !== undefined) report("opacity", "must be a number, read as 1");
  return {
    asset: isAsset ? (asset as AssetId) : null,
    crop: isCropRect(crop) ? { x: crop.x, y: crop.y, w: crop.w, h: crop.h } : null,
    opacity: alpha,
  };
}

export const imageView = defineElementView<ImageModel>({
  name: "image",
  label: imageLabel("name"),
  typeVersion: 1,
  read: (data, _typeVersion, report) => readImage(data, report),
  assets: (model) => (model.asset === null ? [] : [model.asset]),
  draw(model, ctx, box) {
    const dest = { x: 0, y: 0, w: box.w, h: box.h };
    // Assigned in the callback, so the type is given rather than narrowed.
    let state = "missing" as ImageState;
    ctx.withOpacity(model.opacity, () => {
      if (model.asset !== null)
        state = ctx.drawImage(model.asset, dest, model.crop ? { crop: model.crop } : {});
    });
    if (state === "drawn") return;
    // Loading or missing: a grey box with a cross; missing also says so.
    const frame = ctx.createPath();
    frame.rect(0, 0, box.w, box.h);
    ctx.fill(frame, "rgb(203 213 225)");
    const cross = ctx.createPath();
    cross.moveTo(0, 0);
    cross.lineTo(box.w, box.h);
    cross.moveTo(box.w, 0);
    cross.lineTo(0, box.h);
    ctx.stroke(cross, { color: "rgb(148 163 184)", width: 1 / ctx.scale });
    if (state === "missing" && ctx.detail === "full") {
      const fontSize = Math.min(14 / ctx.scale, box.h / 4);
      const layout = ctx.layoutText(
        ctx.t(imageLabel("missing")),
        { fontFamily: "sans", fontSize, color: "rgb(71 85 105)", align: "center" },
        box.w,
      );
      ctx.drawText(layout, 0, (box.h - layout.height) / 2);
    }
  },
});

export const imageViewExtension = defineViewExtension({
  id: IMAGE_EXTENSION,
  version: "0.1.0",
  api: EXTENSION_API_VERSION,
  messages: [imageMessages],
  elementTypes: [imageView],
});
