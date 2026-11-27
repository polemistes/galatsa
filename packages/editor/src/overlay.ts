// SPDX-License-Identifier: GPL-3.0-or-later

// The overlay (tool previews, the selection outline) is drawn in screen space:
// the renderer gives a drawing context in CSS pixels of the drawing area. A
// tool draws its preview in a space of the document (root space, as its
// pointer events give it, docs/adr/0005 section 5); the editor gives it a
// drawing context that projects that space onto the screen through the camera.
// The projection is computed from the offset between that space and the
// camera's own (`spaceMap` of the renderer), never through root coordinates,
// so it stays exact when the camera is anchored in a frame far from the root.

import type { ElementId } from "@galatsa/core";
import type {
  DrawContext,
  Path,
  StrokeStyle,
  TextLayout,
} from "@galatsa/extension-api/editing";

/** A space of the document on screen: screen = point * scale + (ox, oy), in CSS pixels. */
export interface Projection {
  readonly space: ElementId | null;
  readonly scale: number;
  readonly ox: number;
  readonly oy: number;
}

type PathOp = (
  target: Path,
  map: (x: number, y: number) => [number, number],
  k: number,
) => void;

/** A path recorded in document units, drawn through the projection when it is used. */
class RecordedPath implements Path {
  readonly ops: PathOp[] = [];

  moveTo(x: number, y: number): void {
    this.ops.push((p, m) => p.moveTo(...m(x, y)));
  }
  lineTo(x: number, y: number): void {
    this.ops.push((p, m) => p.lineTo(...m(x, y)));
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.ops.push((p, m) => p.quadraticCurveTo(...m(cx, cy), ...m(x, y)));
  }
  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ): void {
    this.ops.push((p, m) => p.bezierCurveTo(...m(c1x, c1y), ...m(c2x, c2y), ...m(x, y)));
  }
  arc(x: number, y: number, r: number, start: number, end: number, ccw?: boolean): void {
    this.ops.push((p, m, k) => p.arc(...m(x, y), r * k, start, end, ccw));
  }
  ellipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    ccw?: boolean,
  ): void {
    this.ops.push((p, m, k) =>
      p.ellipse(...m(cx, cy), rx * k, ry * k, rotation, start, end, ccw),
    );
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.ops.push((p, m, k) => p.rect(...m(x, y), w * k, h * k));
  }
  roundRect(x: number, y: number, w: number, h: number, radius: number): void {
    this.ops.push((p, m, k) => p.roundRect(...m(x, y), w * k, h * k, radius * k));
  }
  closePath(): void {
    this.ops.push((p) => p.closePath());
  }
}

/**
 * A drawing context in the space of `projection`, drawing into `screen`, a
 * context in CSS pixels. `scale` is device pixels per document unit, as tools
 * expect.
 */
export function projectedContext(
  screen: DrawContext,
  projection: Projection,
): DrawContext {
  const k = projection.scale;
  let dx = 0;
  let dy = 0;
  const map = (x: number, y: number): [number, number] => [
    (x + dx) * k + projection.ox,
    (y + dy) * k + projection.oy,
  ];
  const replay = (path: Path): Path => {
    const out = screen.createPath();
    if (path instanceof RecordedPath) for (const op of path.ops) op(out, map, k);
    return out;
  };
  const layouts = new WeakMap<TextLayout, TextLayout>();
  const context: DrawContext = {
    scale: screen.scale * k,
    detail: screen.detail,
    createPath: () => new RecordedPath(),
    fill: (path, color) => screen.fill(replay(path), color),
    stroke: (path, style: StrokeStyle) =>
      screen.stroke(replay(path), {
        ...style,
        width: style.width * k,
        ...(style.dash ? { dash: style.dash.map((d) => d * k) } : {}),
      }),
    withOpacity: (alpha, draw) => screen.withOpacity(alpha, draw),
    withClip: (path, draw) => screen.withClip(replay(path), draw),
    withOffset(x, y, draw) {
      dx += x;
      dy += y;
      try {
        draw();
      } finally {
        dx -= x;
        dy -= y;
      }
    },
    drawImage(asset, dest, options) {
      const [x, y] = map(dest.x, dest.y);
      return screen.drawImage(asset, { x, y, w: dest.w * k, h: dest.h * k }, options);
    },
    layoutText(content, style, width) {
      const inner = screen.layoutText(
        content,
        { ...style, fontSize: style.fontSize * k },
        width * k,
      );
      const layout: TextLayout = {
        width: inner.width / k,
        height: inner.height / k,
        lineCount: inner.lineCount,
      };
      layouts.set(layout, inner);
      return layout;
    },
    drawText(layout, x, y) {
      const inner = layouts.get(layout);
      if (inner !== undefined) screen.drawText(inner, ...map(x, y));
    },
    t: (label, values) => screen.t(label, values),
  };
  return context;
}
