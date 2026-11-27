// SPDX-License-Identifier: GPL-3.0-or-later

// Sketch of the image extension, editing part: inserting an image (a command
// that writes an asset reference registers the asset's description in the same
// command), cropping, opacity, and an importer for image files.

import type { AssetId, AssetInfo, ElementId, Rect } from "@galatsa/core";
import { ASSET_ID_PATTERN } from "@galatsa/core";
import { addAsset } from "@galatsa/core/ydoc";
import {
  buildFragment,
  capabilitiesOf,
  defineCommand,
  defineEditExtension,
  defineElementEditing,
  elementFacts,
  insertElement,
  throwIfCancelled,
  updateElementData,
  type CommandContext,
  type ImporterDefinition,
  type Notice,
} from "@galatsa/extension-api/editing";
import { label, readFieldChange } from "./common.ts";
import {
  IMAGE_EXTENSION,
  IMAGE_TYPE,
  imageView,
  imageViewExtension,
  isRect,
} from "./image-view.ts";

export * from "./image-view.ts";

export const IMAGE_INSERT = `${IMAGE_EXTENSION}/insert`;
export const IMAGE_SET_STYLE = `${IMAGE_EXTENSION}/set-style`;
export const IMAGE_SET_CROP = `${IMAGE_EXTENSION}/set-crop`;

export const imageEditing = defineElementEditing(imageView, {
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
  const view = ctx.services.camera.viewport();
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
    const view = ctx.services.camera.viewport();
    return insertElement(ctx, {
      type: IMAGE_TYPE,
      parent: args.parent ?? null,
      x: args.x ?? view.x + view.w / 2 - size.w / 2,
      y: args.y ?? view.y + view.h / 2 - size.h / 2,
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
          view: imageView,
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

export const imageExtension = defineEditExtension({
  view: imageViewExtension,
  contributes: {
    elementTypes: [imageEditing],
    commands: [insertImage, setStyle, setCrop],
    importers: [imageFiles],
  },
});
