// SPDX-License-Identifier: GPL-3.0-or-later

// Test helpers for extensions: a drawing context that records what is drawn
// instead of drawing pixels. Exported as "@galatsa/extension-api/testing"; not
// part of the program.

import type { AssetId, Rect } from "@galatsa/core";
import type { MessageValues } from "@galatsa/i18n";
import type {
  Color,
  DetailLevel,
  DrawContext,
  ImageState,
  Path,
  StrokeStyle,
  TextContent,
  TextLayout,
  TextStyle,
} from "./draw.ts";
import type { Label } from "./ids.ts";

/** One recorded drawing call. */
export type DrawCall =
  | { readonly op: "fill"; readonly path: readonly string[]; readonly color: Color }
  | {
      readonly op: "stroke";
      readonly path: readonly string[];
      readonly style: StrokeStyle;
    }
  | {
      readonly op: "image";
      readonly asset: AssetId;
      readonly dest: Rect;
      readonly crop?: Rect;
    }
  | {
      readonly op: "text";
      readonly text: string;
      readonly style: TextStyle;
      readonly x: number;
      readonly y: number;
    }
  | { readonly op: "begin-opacity"; readonly alpha: number }
  | { readonly op: "end-opacity" }
  | { readonly op: "begin-clip"; readonly path: readonly string[] }
  | { readonly op: "end-clip" }
  | { readonly op: "begin-offset"; readonly x: number; readonly y: number }
  | { readonly op: "end-offset" };

interface FakeLayout extends TextLayout {
  readonly text: string;
  readonly style: TextStyle;
}

function plain(content: TextContent): string {
  if (typeof content === "string") return content;
  return content.delta
    .map((run) => (typeof run.insert === "string" ? run.insert : ""))
    .join("");
}

export interface RecordingDrawContext extends DrawContext {
  readonly calls: DrawCall[];
}

/**
 * A drawing context that records calls. Text is laid out with fixed-width
 * glyphs (0.6 of the font size) and breaks only at newlines; images are
 * "drawn" unless listed in `missing` or `loading`. Messages are shown as
 * "label {values}" unless a translate function is given.
 */
export function createRecordingDrawContext(
  options: {
    readonly scale?: number;
    readonly detail?: DetailLevel;
    readonly missing?: readonly AssetId[];
    readonly loading?: readonly AssetId[];
    readonly t?: (label: Label, values?: MessageValues) => string;
  } = {},
): RecordingDrawContext {
  const calls: DrawCall[] = [];
  const createPath = (): Path & { readonly ops: string[] } => {
    const ops: string[] = [];
    const add =
      (name: string) =>
      (...args: Array<number | boolean | undefined>): void => {
        ops.push(`${name}(${args.filter((a) => a !== undefined).join(",")})`);
      };
    return {
      ops,
      moveTo: add("moveTo"),
      lineTo: add("lineTo"),
      quadraticCurveTo: add("quadraticCurveTo"),
      bezierCurveTo: add("bezierCurveTo"),
      arc: add("arc"),
      ellipse: add("ellipse"),
      rect: add("rect"),
      roundRect: add("roundRect"),
      closePath: add("closePath"),
    };
  };
  const opsOf = (path: Path): readonly string[] => [
    ...(path as Path & { ops: string[] }).ops,
  ];
  return {
    calls,
    scale: options.scale ?? 1,
    detail: options.detail ?? "full",
    createPath,
    fill: (path, color) => calls.push({ op: "fill", path: opsOf(path), color }),
    stroke: (path, style) => calls.push({ op: "stroke", path: opsOf(path), style }),
    withOpacity: (alpha, draw) => {
      calls.push({ op: "begin-opacity", alpha });
      draw();
      calls.push({ op: "end-opacity" });
    },
    withClip: (path, draw) => {
      calls.push({ op: "begin-clip", path: opsOf(path) });
      draw();
      calls.push({ op: "end-clip" });
    },
    withOffset: (x, y, draw) => {
      calls.push({ op: "begin-offset", x, y });
      draw();
      calls.push({ op: "end-offset" });
    },
    drawImage: (asset, dest, drawOptions): ImageState => {
      if (options.missing?.includes(asset)) return "missing";
      if (options.loading?.includes(asset)) return "loading";
      calls.push(
        drawOptions?.crop
          ? { op: "image", asset, dest, crop: drawOptions.crop }
          : { op: "image", asset, dest },
      );
      return "drawn";
    },
    layoutText: (content, style, width): FakeLayout => {
      const text = plain(content);
      const lines = text.split("\n");
      const longest = Math.max(0, ...lines.map((line) => line.length));
      return {
        text,
        style,
        width: Math.min(width, longest * style.fontSize * 0.6),
        height: lines.length * style.fontSize * (style.lineHeight ?? 1.2),
        lineCount: lines.length,
      };
    },
    drawText: (layout, x, y) => {
      const fake = layout as FakeLayout;
      calls.push({ op: "text", text: fake.text, style: fake.style, x, y });
    },
    t: (label, values) =>
      options.t?.(label, values) ??
      (values ? `${label} ${JSON.stringify(values)}` : label),
  };
}
