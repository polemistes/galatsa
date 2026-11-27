// SPDX-License-Identifier: GPL-3.0-or-later

// Sketch of the image extension, viewing part: an image element refers to an
// asset (the bytes live in the asset store, the document holds the asset's
// description), is drawn through the renderer's image levels, and can be
// cropped.

import { ASSET_ID_PATTERN, type AssetId, type Rect } from "@galatsa/core";
import {
  defineElementView,
  defineViewExtension,
  type ImageState,
} from "@galatsa/extension-api";
import { API, label, readNumber } from "./common.ts";
import { exampleMessages } from "./messages/index.ts";

export const IMAGE_EXTENSION = "examples.image";
export const IMAGE_TYPE = `${IMAGE_EXTENSION}/image`;

export interface ImageModel {
  readonly asset: AssetId | null;
  /** The part of the image shown, in the image's pixels; null for all of it. */
  readonly crop: Rect | null;
  readonly opacity: number;
}

export function isRect(value: unknown): value is Rect {
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

export const imageView = defineElementView<ImageModel>({
  name: "image",
  label: label("image.name"),
  typeVersion: 1,
  read(data, _typeVersion, report) {
    const asset = Object.hasOwn(data, "asset") ? data["asset"] : undefined;
    const isAsset = typeof asset === "string" && ASSET_ID_PATTERN.test(asset);
    if (!isAsset) report("asset", "must be an asset id, read as none");
    const crop = Object.hasOwn(data, "crop") ? data["crop"] : null;
    if (crop !== null && !isRect(crop))
      report("crop", "must be a rectangle or null, read as null");
    return {
      asset: isAsset ? (asset as AssetId) : null,
      crop: isRect(crop) ? { x: crop.x, y: crop.y, w: crop.w, h: crop.h } : null,
      opacity: readNumber(data, "opacity", 1, report, { min: 0, max: 1 }),
    };
  },
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
        ctx.t(label("image.missing")),
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
  api: API,
  messages: [exampleMessages],
  elementTypes: [imageView],
});
