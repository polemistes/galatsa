// SPDX-License-Identifier: GPL-3.0-or-later

// Sketch of the image extension: an image element refers to an asset (the
// bytes live in the asset store, the document holds the asset's description),
// is drawn through the renderer's image levels, can be cropped, and comes in
// through an importer for image files. A command that writes an asset
// reference registers the asset's description in the same command.

import type { AssetId, AssetInfo, ElementId, Rect } from "@galatsa/core";
import { ASSET_ID_PATTERN } from "@galatsa/core";
import { addAsset } from "@galatsa/core/ydoc";
import {
  buildFragment,
  capabilitiesOf,
  defineCommand,
  defineElementType,
  defineExtension,
  elementFacts,
  insertElement,
  throwIfCancelled,
  updateElementData,
  type CommandContext,
  type ImageState,
  type ImporterDefinition,
  type Notice,
} from "@galatsa/extension-api";
import { API, label, readFieldChange, readNumber } from "./common.ts";
import { exampleMessages } from "./messages/index.ts";

export const IMAGE_EXTENSION = "examples.image";
export const IMAGE_TYPE = `${IMAGE_EXTENSION}/image`;
export const IMAGE_INSERT = `${IMAGE_EXTENSION}/insert`;
export const IMAGE_SET_STYLE = `${IMAGE_EXTENSION}/set-style`;
export const IMAGE_SET_CROP = `${IMAGE_EXTENSION}/set-crop`;

export interface ImageModel {
  readonly asset: AssetId | null;
  /** The part of the image shown, in the image's pixels; null for all of it. */
  readonly crop: Rect | null;
  readonly opacity: number;
}

function isRect(value: unknown): value is Rect {
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

export const imageType = defineElementType<ImageModel>({
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
  properties: [
    {
      key: "opacity",
      label: label("image.opacity"),
      control: { kind: "number", min: 0, max: 1, step: 0.05 },
      get: (m) => m.opacity,
      command: IMAGE_SET_STYLE,
    },
  ],
});

export interface InsertImageArgs {
  readonly asset: AssetId;
  readonly info: AssetInfo;
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  readonly parent?: ElementId | null;
}

/** Size of a new image: its pixel size, scaled down to fit half the view. */
function initialSize(info: AssetInfo, ctx: CommandContext): { w: number; h: number } {
  const w = info.width ?? 400;
  const h = info.height ?? info.width ?? 400;
  const view = ctx.viewport;
  if (!view) return { w, h };
  const fit = Math.min(1, view.w / 2 / w, view.h / 2 / h);
  return { w: w * fit, h: h * fit };
}

const insertImage = defineCommand<InsertImageArgs, ElementId>({
  name: "insert",
  label: label("image.insert"),
  quick: true,
  enabled: (_ctx, args) =>
    args !== undefined &&
    typeof args.asset === "string" &&
    ASSET_ID_PATTERN.test(args.asset),
  execute(ctx, args) {
    // The asset reference and its description are written by the same command.
    addAsset(ctx.doc, args.asset, args.info);
    const size =
      args.w !== undefined && args.h !== undefined
        ? { w: args.w, h: args.h }
        : initialSize(args.info, ctx);
    const view = ctx.viewport;
    return insertElement(ctx, {
      type: IMAGE_TYPE,
      parent: args.parent ?? null,
      x: args.x ?? (view ? view.x + view.w / 2 - size.w / 2 : 0),
      y: args.y ?? (view ? view.y + view.h / 2 - size.h / 2 : 0),
      size,
      name: args.info.name ?? "",
      data: { asset: args.asset, crop: null, opacity: 1 },
    });
  },
});

function allEditableImages(ctx: CommandContext, ids: readonly ElementId[]): boolean {
  return (
    ids.length > 0 &&
    ids.every(
      (id) =>
        elementFacts(ctx, id).type === IMAGE_TYPE && capabilitiesOf(ctx, id).editContent,
    )
  );
}

const setStyle = defineCommand<unknown, void>({
  name: "set-style",
  label: label("image.set-style"),
  enabled(ctx, args) {
    const change = readFieldChange(args);
    return change?.key === "opacity" && allEditableImages(ctx, change.ids);
  },
  execute(ctx, args) {
    const change = readFieldChange(args)!;
    for (const id of change.ids) updateElementData(ctx, id, { opacity: change.value });
  },
});

const setCrop = defineCommand<
  { readonly ids: readonly ElementId[]; readonly crop: Rect | null },
  void
>({
  name: "set-crop",
  label: label("image.set-crop"),
  enabled: (ctx, args) =>
    args !== undefined &&
    (args.crop === null || isRect(args.crop)) &&
    allEditableImages(ctx, args.ids),
  execute(ctx, args) {
    for (const id of args.ids)
      updateElementData(ctx, id, {
        crop:
          args.crop === null
            ? null
            : { x: args.crop.x, y: args.crop.y, w: args.crop.w, h: args.crop.h },
      });
  },
});

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  return prefix.every((b, i) => bytes[at + i] === b);
}

/** Pixel size from a PNG header; other formats are left to the real extension. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || !startsWith(bytes, PNG)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function mediaTypeOf(name: string, head: Uint8Array, given: string | undefined): string {
  if (startsWith(head, PNG)) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return "image/webp";
  if (given !== undefined && given !== "") return given;
  return name.toLowerCase().endsWith(".svg")
    ? "image/svg+xml"
    : "application/octet-stream";
}

const imageFiles: ImporterDefinition = {
  name: "files",
  label: label("image.files"),
  quick: true,
  fileTypes: [
    {
      label: label("image.file-type.png"),
      mediaTypes: ["image/png"],
      extensions: ["png"],
    },
    {
      label: label("image.file-type.jpeg"),
      mediaTypes: ["image/jpeg"],
      extensions: ["jpg", "jpeg"],
    },
    {
      label: label("image.file-type.webp"),
      mediaTypes: ["image/webp"],
      extensions: ["webp"],
    },
    {
      label: label("image.file-type.svg"),
      mediaTypes: ["image/svg+xml"],
      extensions: ["svg"],
    },
  ],
  sniff: (head) =>
    startsWith(head, PNG) ||
    startsWith(head, [0xff, 0xd8, 0xff]) ||
    (startsWith(head, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)),
  async read(source, context) {
    context.progress(undefined);
    // Images are read whole: decoding needs all the bytes anyway.
    const bytes = await source.bytes();
    throwIfCancelled(context.cancellation);
    const size = pngSize(bytes);
    const notices: Notice[] = [];
    if (!size)
      notices.push({
        message: label("image.notice.size-unknown"),
        values: { name: source.name },
      });
    const { id, info } = await context.assets.put(bytes, {
      mediaType: mediaTypeOf(source.name, bytes.subarray(0, 16), source.mediaType),
      name: source.name,
      ...(size ?? {}),
    });
    throwIfCancelled(context.cancellation);
    context.progress(1);
    const side = 400;
    const fragment = buildFragment(
      [
        {
          type: IMAGE_TYPE,
          definition: imageType,
          x: 0,
          y: 0,
          w: size?.width ?? side,
          h: size?.height ?? side,
          name: source.name,
          data: { asset: id, crop: null, opacity: 1 },
        },
      ],
      { [id]: info },
    );
    return { fragment, notices };
  },
};

export const imageExtension = defineExtension({
  id: IMAGE_EXTENSION,
  version: "0.1.0",
  api: API,
  messages: [exampleMessages],
  contributes: {
    elementTypes: [imageType],
    commands: [insertImage, setStyle, setCrop],
    importers: [imageFiles],
  },
});
