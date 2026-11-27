// SPDX-License-Identifier: GPL-3.0-or-later

// @galatsa/extension-image: the image extension with its editing part.
// Importing PNG, JPEG, WebP and SVG files (the editor hands it files that are
// dropped, pasted or picked), inserting, opacity, and cropping with a tool. A
// viewer imports "@galatsa/extension-image/view". See
// docs/adr/0012-images-and-assets.md.
//
// The asset's bytes are stored through the host's asset store before any
// command runs; the host also makes the image's reduced versions there. A
// command that writes an asset reference registers the asset's description in
// the same command (docs/adr/0005, section 3.6).

import {
  ASSET_ID_PATTERN,
  Resolver,
  type AssetId,
  type AssetInfo,
  type ElementId,
  type Json,
  type Rect,
  type Size,
} from "@galatsa/core";
import { addAsset, moveElement, resizeElement, roots, yLookup } from "@galatsa/core/ydoc";
import { canTarget } from "@galatsa/extension-basics";
import {
  buildFragment,
  capabilitiesOf,
  defineCommand,
  defineEditExtension,
  defineElementEditing,
  elementFacts,
  insertElement,
  readData,
  throwIfCancelled,
  updateElementData,
  type CommandContext,
  type EditExtension,
  type FieldChange,
  type ImporterDefinition,
  type Notice,
  type ToolSession,
} from "@galatsa/extension-api/editing";
import * as Y from "yjs";
import {
  boxForCrop,
  clampCrop,
  cropTool,
  fullCrop,
  sameCrop,
  type CropTarget,
} from "./crop.ts";
import { imageFacts, sniffImage } from "./facts.ts";
import {
  IMAGE_EXTENSION,
  IMAGE_TYPE,
  imageLabel,
  imageView,
  imageViewExtension,
  isCropRect,
  readImage,
  type ImageModel,
} from "./view.ts";

export * from "./view.ts";
export {
  boxForCrop,
  clampCrop,
  dragCrop,
  drawCropOverlay,
  fromBoxFrame,
  fullCrop,
  HANDLES,
  MIN_CROP_PIXELS,
  toBoxFrame,
  type CropBox,
  type CropTarget,
  type Handle,
} from "./crop.ts";

export const IMAGE_INSERT = `${IMAGE_EXTENSION}/insert`;
export const IMAGE_SET_STYLE = `${IMAGE_EXTENSION}/set-style`;
export const IMAGE_CROP = `${IMAGE_EXTENSION}/crop`;
export const IMAGE_CROP_RESET = `${IMAGE_EXTENSION}/crop-reset`;
export const IMAGE_CROP_TOOL = `${IMAGE_EXTENSION}/crop-tool`;
export const IMAGE_IMPORTER = `${IMAGE_EXTENSION}/files`;

/** A new image is at most this part of the view across and down. */
export const FIT_FRACTION = 0.5;
/** The side of an image whose size could not be read. */
export const UNKNOWN_SIDE = 400;

/** The natural pixel size of an asset, from its description in the document. */
export function assetSize(doc: Y.Doc, asset: AssetId): Size | null {
  const value = roots(doc).assets.get(asset) as unknown;
  if (value === null || typeof value !== "object") return null;
  // A description written as a shared map (a peer may do that) or a plain object.
  const get = (key: string): unknown =>
    value instanceof Y.Map ? value.get(key) : (value as Record<string, unknown>)[key];
  const w = get("width");
  const h = get("height");
  return typeof w === "number" && typeof h === "number" && w > 0 && h > 0
    ? { w, h }
    : null;
}

/** The size of a new image: its pixel size, scaled down to fit part of the view. */
export function fitSize(
  natural: { readonly width?: number; readonly height?: number },
  view: Rect | undefined,
): { w: number; h: number } {
  const w = natural.width ?? UNKNOWN_SIDE;
  const h = natural.height ?? natural.width ?? UNKNOWN_SIDE;
  if (view === undefined || !(view.w > 0) || !(view.h > 0)) return { w, h };
  const fit = Math.min(1, (view.w * FIT_FRACTION) / w, (view.h * FIT_FRACTION) / h);
  return { w: w * fit, h: h * fit };
}

/** True if an asset description gives a pixel size. */
export function hasSize(info: {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}): boolean {
  const { width, height } = info;
  return (
    typeof width === "number" &&
    typeof height === "number" &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  );
}

function resolve(ctx: Pick<CommandContext, "doc">): Resolver {
  return new Resolver(yLookup(ctx.doc));
}

/** True for images the user may change: there, seen, unlocked, of this type. */
function editableImage(ctx: CommandContext, r: Resolver, id: ElementId): boolean {
  try {
    return (
      canTarget(ctx, r, id) &&
      elementFacts(ctx, id).type === IMAGE_TYPE &&
      capabilitiesOf(ctx, id).editContent
    );
  } catch {
    return false;
  }
}

function modelOf(ctx: Pick<CommandContext, "doc">, id: ElementId): ImageModel {
  return readImage(readData(ctx, id), () => {});
}

export const imageEditing = defineElementEditing(imageView, {
  properties: [
    {
      key: "opacity",
      label: imageLabel("opacity"),
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

const insertImage = defineCommand<InsertImageArgs, ElementId>({
  name: "insert",
  label: imageLabel("insert"),
  undoLabel: imageLabel("insert.step"),
  quick: true,
  // An image without a pixel size could never be drawn: refused.
  enabled: (_ctx, args) =>
    args !== undefined &&
    typeof args.asset === "string" &&
    ASSET_ID_PATTERN.test(args.asset) &&
    typeof args.info === "object" &&
    args.info !== null &&
    hasSize(args.info),
  execute(ctx, args) {
    // The asset reference and its description are written by the same command.
    addAsset(ctx.doc, args.asset, args.info);
    const view = ctx.services.camera.viewport();
    const size =
      args.w !== undefined && args.h !== undefined
        ? { w: args.w, h: args.h }
        : fitSize(args.info, view);
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

function readFieldChange(args: unknown): FieldChange | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const { ids, key, value } = args as Partial<FieldChange>;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return undefined;
  if (typeof key !== "string" || value === undefined) return undefined;
  return { ids, key, value: value as Json };
}

const setStyle = defineCommand<unknown, void>({
  name: "set-style",
  label: imageLabel("set-style"),
  undoLabel: imageLabel("set-style.step"),
  enabled(ctx, args) {
    const change = readFieldChange(args);
    if (change?.key !== "opacity") return false;
    const v = change.value;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return false;
    const r = resolve(ctx);
    return (
      change.ids.length > 0 &&
      change.ids.every((id) => editableImage(ctx, r, id)) &&
      change.ids.some((id) => modelOf(ctx, id).opacity !== v)
    );
  },
  execute(ctx, args) {
    const change = readFieldChange(args)!;
    for (const id of change.ids)
      if (modelOf(ctx, id).opacity !== change.value)
        updateElementData(ctx, id, { opacity: change.value });
  },
});

export interface CropArgs {
  readonly id: ElementId;
  /** The part to show, in the image's pixels; null for the whole image. */
  readonly crop: Rect | null;
}

/**
 * What a crop writes for one image: the crop kept inside the image, and the
 * box that keeps the image where it is. Undefined if it cannot be cropped or
 * nothing would change.
 */
function planCrop(
  ctx: CommandContext,
  args: CropArgs | undefined,
):
  { crop: Rect | null; box: { x: number; y: number; w: number; h: number } } | undefined {
  if (args === undefined || typeof args.id !== "string") return undefined;
  if (args.crop !== null && !isCropRect(args.crop)) return undefined;
  const r = resolve(ctx);
  if (!editableImage(ctx, r, args.id)) return undefined;
  const model = modelOf(ctx, args.id);
  if (model.asset === null) return undefined;
  const natural = assetSize(ctx.doc, model.asset);
  if (natural === null) return undefined;
  const current = model.crop ?? fullCrop(natural);
  const whole = fullCrop(natural);
  const next = clampCrop(args.crop ?? whole, natural);
  if (next === null || sameCrop(next, current)) return undefined;
  const record = r.get(args.id);
  const size = record?.size;
  if (size === undefined) return undefined;
  const at = r.localPosition(args.id);
  const box = boxForCrop(
    { x: at.x, y: at.y, w: size.w, h: size.h, rot: record?.rot ?? 0 },
    current,
    next,
  );
  if (box === undefined) return undefined;
  return { crop: sameCrop(next, whole) ? null : next, box };
}

const crop = defineCommand<CropArgs, void>({
  name: "crop",
  label: imageLabel("crop"),
  undoLabel: imageLabel("crop.step"),
  quick: true,
  enabled: (ctx, args) => planCrop(ctx, args) !== undefined,
  execute(ctx, args) {
    const plan = planCrop(ctx, args)!;
    updateElementData(ctx, args.id, {
      crop:
        plan.crop === null
          ? null
          : { x: plan.crop.x, y: plan.crop.y, w: plan.crop.w, h: plan.crop.h },
    });
    resizeElement(ctx.doc, args.id, plan.box.w, plan.box.h);
    moveElement(ctx.doc, args.id, plan.box.x, plan.box.y);
  },
});

/** Shows the whole image again: a crop to null, for the selected images. */
const cropReset = defineCommand<{ readonly ids: readonly ElementId[] }, void>({
  name: "crop-reset",
  label: imageLabel("crop-reset"),
  undoLabel: imageLabel("crop-reset.step"),
  quick: true,
  enabled: (ctx, args) =>
    args !== undefined &&
    Array.isArray(args.ids) &&
    args.ids.some((id) => planCrop(ctx, { id, crop: null }) !== undefined),
  execute(ctx, args) {
    for (const id of args.ids) {
      const plan = planCrop(ctx, { id, crop: null });
      if (plan === undefined) continue;
      updateElementData(ctx, id, { crop: null });
      resizeElement(ctx.doc, id, plan.box.w, plan.box.h);
      moveElement(ctx.doc, id, plan.box.x, plan.box.y);
    }
  },
});

/** The image the crop tool may work on. */
function cropTarget(session: ToolSession, id: ElementId): CropTarget | null {
  const env = session.environment();
  const placement = env.services.scene.placement(id);
  if (placement === null) return null;
  const facts = (() => {
    try {
      return elementFacts({ doc: env.doc }, id);
    } catch {
      return null;
    }
  })();
  if (facts === null || facts.type !== IMAGE_TYPE) return null;
  if (!canCrop(session, id)) return null;
  const model = readImage(readData({ doc: env.doc }, id), () => {});
  if (model.asset === null) return null;
  const natural = assetSize(env.doc, model.asset);
  if (natural === null) return null;
  return {
    id,
    asset: model.asset,
    placement,
    natural,
    crop: model.crop ?? fullCrop(natural),
  };
}

/** Whether the crop command would take some crop of this image (it is editable). */
function canCrop(session: ToolSession, id: ElementId): boolean {
  const env = session.environment();
  const model = readImage(readData({ doc: env.doc }, id), () => {});
  if (model.asset === null) return false;
  const natural = assetSize(env.doc, model.asset);
  if (natural === null) return false;
  const shown = model.crop ?? fullCrop(natural);
  // A crop a pixel smaller than what is shown, as a probe.
  const probe = clampCrop({ ...shown, w: shown.w - 1 }, natural);
  return probe !== null && session.isEnabled(IMAGE_CROP, { id, crop: probe });
}

const imageFiles: ImporterDefinition = {
  name: "files",
  label: imageLabel("files"),
  quick: true,
  fileTypes: [
    {
      label: imageLabel("file-type.png"),
      mediaTypes: ["image/png"],
      extensions: ["png"],
    },
    {
      label: imageLabel("file-type.jpeg"),
      mediaTypes: ["image/jpeg"],
      extensions: ["jpg", "jpeg"],
    },
    {
      label: imageLabel("file-type.webp"),
      mediaTypes: ["image/webp"],
      extensions: ["webp"],
    },
    {
      label: imageLabel("file-type.svg"),
      mediaTypes: ["image/svg+xml"],
      extensions: ["svg"],
    },
  ],
  sniff: (head) => sniffImage(head) !== null,
  async read(source, context) {
    context.progress(undefined);
    // Images are read whole: decoding needs all the bytes anyway.
    const bytes = await source.bytes();
    throwIfCancelled(context.cancellation);
    const facts = imageFacts(bytes, source.name, source.mediaType);
    if (facts === null) {
      return {
        fragment: buildFragment([]),
        notices: [
          { message: imageLabel("notice.not-image"), values: { name: source.name } },
        ],
      };
    }
    const notices: Notice[] = [];
    // The host stores the bytes once (by their hash) and makes the reduced
    // versions; the same file imported again gives the same asset. A size the
    // header did not give, the host may find by decoding the image.
    const { id, info } = await context.assets.put(bytes, {
      mediaType: facts.mediaType,
      name: source.name,
      ...(facts.width !== undefined ? { width: facts.width, height: facts.height! } : {}),
    });
    throwIfCancelled(context.cancellation);
    context.progress(1);
    if (!hasSize(info)) {
      // An image without a size cannot be drawn: it is not inserted.
      return {
        fragment: buildFragment([]),
        notices: [
          { message: imageLabel("notice.size-unknown"), values: { name: source.name } },
        ],
      };
    }
    const size = fitSize(info, context.view);
    const fragment = buildFragment(
      [
        {
          type: IMAGE_TYPE,
          view: imageView,
          x: 0,
          y: 0,
          w: size.w,
          h: size.h,
          name: source.name,
          data: { asset: id, crop: null, opacity: 1 },
        },
      ],
      { [id]: info },
    );
    return { fragment, notices };
  },
};

export const imageExtension: EditExtension = defineEditExtension({
  view: imageViewExtension,
  contributes: {
    elementTypes: [imageEditing],
    commands: [insertImage, setStyle, crop, cropReset],
    tools: [
      cropTool({
        name: "crop-tool",
        label: imageLabel("crop-tool"),
        shortcuts: ["c"],
        command: IMAGE_CROP,
        target: cropTarget,
      }),
    ],
    importers: [imageFiles],
  },
});
