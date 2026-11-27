// SPDX-License-Identifier: GPL-3.0-or-later

// Helpers for the renderer's tests: a recording stand-in for a 2D context, small
// documents, and element types that draw through the DrawContext. Not exported
// from the package entry.

import {
  FRAME_TYPE,
  GROUP_TYPE,
  type Element,
  type ElementData,
  type ElementId,
} from "@galatsa/core";
import {
  defineElementView,
  defineViewExtension,
  EXTENSION_API_VERSION,
  ViewHost,
  type Label,
} from "@galatsa/extension-api";
import type { Canvas2D } from "./canvas.ts";

/** One call or assignment on the recording context. */
export interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** A 2D context that records what it is told and draws nothing. */
export class RecordingContext implements Canvas2D {
  calls: Call[] = [];
  #state: Record<string, unknown> = {};
  readonly #stack: Array<Record<string, unknown>> = [];

  #set(name: string, value: unknown): void {
    this.#state[name] = value;
    this.calls.push({ name: `set ${name}`, args: [value] });
  }
  #get<T>(name: string, fallback: T): T {
    return (this.#state[name] as T | undefined) ?? fallback;
  }
  #call(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }

  get globalAlpha(): number {
    return this.#get("globalAlpha", 1);
  }
  set globalAlpha(v: number) {
    this.#set("globalAlpha", v);
  }
  get fillStyle(): string {
    return this.#get("fillStyle", "#000");
  }
  set fillStyle(v: string | CanvasGradient | CanvasPattern) {
    this.#set("fillStyle", v);
  }
  get strokeStyle(): string {
    return this.#get("strokeStyle", "#000");
  }
  set strokeStyle(v: string | CanvasGradient | CanvasPattern) {
    this.#set("strokeStyle", v);
  }
  get lineWidth(): number {
    return this.#get("lineWidth", 1);
  }
  set lineWidth(v: number) {
    this.#set("lineWidth", v);
  }
  get lineJoin(): CanvasLineJoin {
    return this.#get("lineJoin", "miter");
  }
  set lineJoin(v: CanvasLineJoin) {
    this.#set("lineJoin", v);
  }
  get lineCap(): CanvasLineCap {
    return this.#get("lineCap", "butt");
  }
  set lineCap(v: CanvasLineCap) {
    this.#set("lineCap", v);
  }
  get miterLimit(): number {
    return this.#get("miterLimit", 10);
  }
  set miterLimit(v: number) {
    this.#set("miterLimit", v);
  }
  get lineDashOffset(): number {
    return this.#get("lineDashOffset", 0);
  }
  set lineDashOffset(v: number) {
    this.#set("lineDashOffset", v);
  }
  get font(): string {
    return this.#get("font", "10px sans-serif");
  }
  set font(v: string) {
    this.#set("font", v);
  }
  get textAlign(): CanvasTextAlign {
    return this.#get("textAlign", "start");
  }
  set textAlign(v: CanvasTextAlign) {
    this.#set("textAlign", v);
  }
  get textBaseline(): CanvasTextBaseline {
    return this.#get("textBaseline", "alphabetic");
  }
  set textBaseline(v: CanvasTextBaseline) {
    this.#set("textBaseline", v);
  }
  get imageSmoothingEnabled(): boolean {
    return this.#get("imageSmoothingEnabled", true);
  }
  set imageSmoothingEnabled(v: boolean) {
    this.#set("imageSmoothingEnabled", v);
  }
  setLineDash(segments: number[]): void {
    this.#call("setLineDash", segments);
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.#call("setTransform", a, b, c, d, e, f);
  }
  save(): void {
    this.#stack.push({ ...this.#state });
    this.#call("save");
  }
  restore(): void {
    this.#state = this.#stack.pop() ?? {};
    this.#call("restore");
  }
  beginPath(): void {
    this.#call("beginPath");
  }
  moveTo(x: number, y: number): void {
    this.#call("moveTo", x, y);
  }
  lineTo(x: number, y: number): void {
    this.#call("lineTo", x, y);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.#call("quadraticCurveTo", cpx, cpy, x, y);
  }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void {
    this.#call("bezierCurveTo", a, b, c, d, x, y);
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void {
    this.#call("arc", x, y, r, a0, a1, ccw ?? false);
  }
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rot: number,
    a0: number,
    a1: number,
    ccw?: boolean,
  ): void {
    this.#call("ellipse", x, y, rx, ry, rot, a0, a1, ccw ?? false);
  }
  closePath(): void {
    this.#call("closePath");
  }
  fill(rule?: CanvasFillRule): void {
    this.#call("fill", rule);
  }
  stroke(): void {
    this.#call("stroke");
  }
  clip(rule?: CanvasFillRule): void {
    this.#call("clip", rule);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.#call("fillRect", x, y, w, h);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.#call("clearRect", x, y, w, h);
  }
  fillText(text: string, x: number, y: number): void {
    this.#call("fillText", text, x, y);
  }
  drawImage(image: CanvasImageSource, ...args: number[]): void {
    this.#call("drawImage", image, ...args);
  }

  /** Calls with this name since the last clear. */
  named(name: string): Call[] {
    return this.calls.filter((c) => c.name === name);
  }

  /** Every number given to a path, rectangle, text or image call. */
  coordinates(): number[] {
    const out: number[] = [];
    for (const c of this.calls) {
      if (
        ["moveTo", "lineTo", "quadraticCurveTo", "bezierCurveTo", "fillText"].includes(
          c.name,
        )
      )
        for (const a of c.args) if (typeof a === "number") out.push(a);
      if (c.name === "arc" || c.name === "ellipse")
        out.push(c.args[0] as number, c.args[1] as number);
      if (c.name === "setTransform") out.push(c.args[4] as number, c.args[5] as number);
    }
    return out;
  }
}

let counter = 0;

/** A minimal element record. */
export function element(
  fields: Partial<Element> & { type: string; id?: ElementId; data?: ElementData },
): Element {
  counter++;
  return {
    typeVersion: 1,
    parent: null,
    order: `k${String(counter).padStart(8, "0")}`,
    pos: { x: 0, y: 0, space: fields.parent ?? null },
    rebase: null,
    name: "",
    locked: false,
    rev: {},
    deleted: {},
    dissolved: false,
    purged: false,
    refs: [],
    ext: {},
    data: {},
    ...(fields.type === FRAME_TYPE || fields.type === GROUP_TYPE ? {} : { rot: 0 }),
    ...fields,
  } as Element;
}

/** Element at a position in its parent, with a size. */
export function box(
  type: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<Element> = {},
): Element {
  return element({
    type,
    pos: { x, y, space: extra.parent ?? null },
    size: { w, h },
    ...extra,
  } as Partial<Element> & { type: string });
}

export const RECT = "test/rect";
export const ELLIPSE = "test/ellipse";
export const TEXT = "test/text";
export const IMAGE = "test/image";
export const CIRCLE_STROKE = "test/ring";

const label = "common:test" as Label;

/** A host with test element types; `drawn` collects the ids drawn, in order. */
export function testHost(): { host: ViewHost; drawn: ElementId[] } {
  const drawn: ElementId[] = [];
  const host = new ViewHost();
  const color = (data: ElementData): string =>
    typeof data["color"] === "string" ? data["color"] : "#123456";
  const problems = host.load([
    defineViewExtension({
      id: "test",
      version: "0.0.0",
      api: EXTENSION_API_VERSION,
      elementTypes: [
        defineElementView<{ color: string }>({
          name: "rect",
          label,
          typeVersion: 1,
          read: (data) => ({ color: color(data) }),
          draw(model, ctx, b) {
            drawn.push(b.id);
            const p = ctx.createPath();
            p.rect(0, 0, b.w, b.h);
            ctx.fill(p, model.color);
          },
        }),
        defineElementView<{ color: string }>({
          name: "ellipse",
          label,
          typeVersion: 1,
          read: (data) => ({ color: color(data) }),
          draw(model, ctx, b) {
            drawn.push(b.id);
            const p = ctx.createPath();
            p.ellipse(b.w / 2, b.h / 2, b.w / 2, b.h / 2, 0, 0, 2 * Math.PI);
            ctx.fill(p, model.color);
          },
          hitTest(_model, point, b, tolerance) {
            const rx = b.w / 2 + tolerance;
            const ry = b.h / 2 + tolerance;
            const dx = point.x - b.w / 2;
            const dy = point.y - b.h / 2;
            return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
          },
        }),
        defineElementView<{ width: number }>({
          name: "ring",
          label,
          typeVersion: 1,
          read: (data) => ({
            width: typeof data["width"] === "number" ? data["width"] : 1,
          }),
          draw(model, ctx, b) {
            drawn.push(b.id);
            const p = ctx.createPath();
            p.arc(b.w / 2, b.h / 2, b.w / 2, 0, 2 * Math.PI);
            ctx.stroke(p, { color: "#000", width: model.width });
          },
          bounds: (model, b) => ({
            x: -model.width / 2,
            y: -model.width / 2,
            w: b.w + model.width,
            h: b.h + model.width,
          }),
        }),
        defineElementView<{ text: string; size: number }>({
          name: "text",
          label,
          typeVersion: 1,
          read: (data) => ({
            text: typeof data["text"] === "string" ? data["text"] : "",
            size: typeof data["size"] === "number" ? data["size"] : 10,
          }),
          draw(model, ctx, b) {
            drawn.push(b.id);
            const layout = ctx.layoutText(
              model.text,
              { fontFamily: "sans", fontSize: model.size, color: "#000", align: "left" },
              b.w,
            );
            ctx.drawText(layout, 0, 0);
          },
        }),
        defineElementView<{ asset: string }>({
          name: "image",
          label,
          typeVersion: 1,
          read: (data) => ({
            asset: typeof data["asset"] === "string" ? data["asset"] : "",
          }),
          draw(model, ctx, b) {
            drawn.push(b.id);
            ctx.drawImage(model.asset as `sha256-${string}`, {
              x: 0,
              y: 0,
              w: b.w,
              h: b.h,
            });
          },
        }),
      ],
    }),
  ]);
  if (problems.length > 0) throw new Error(JSON.stringify(problems));
  return { host, drawn };
}

/** Elements keyed by id, from a list (ids from the list or generated). */
export function record(list: ReadonlyArray<[ElementId, Element]>): {
  [id: ElementId]: Element;
} {
  const out: { [id: ElementId]: Element } = {};
  for (const [id, e] of list) out[id] = e;
  return out;
}
