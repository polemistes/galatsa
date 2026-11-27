// SPDX-License-Identifier: GPL-3.0-or-later

// The part of the Canvas 2D API the renderer uses. CanvasRenderingContext2D and
// OffscreenCanvasRenderingContext2D both have it; tests use a recording stand-in.

export interface Canvas2D {
  globalAlpha: number;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
  miterLimit: number;
  lineDashOffset: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  imageSmoothingEnabled: boolean;
  setLineDash(segments: number[]): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  closePath(): void;
  fill(fillRule?: CanvasFillRule): void;
  stroke(): void;
  clip(fillRule?: CanvasFillRule): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/**
 * Canvas state the renderer sets often, cached so that each value is assigned
 * only when it changes. Assigning a colour or a font makes the browser parse it,
 * and WebKitGTK in particular pays for every font assignment (see docs/adr/0004).
 * Everything that changes the canvas state must go through this object while a
 * frame is drawn; save() and restore() keep the cache in step.
 */
export class CanvasState {
  readonly ctx: Canvas2D;
  #fill = "";
  #stroke = "";
  #alpha = 1;
  #font = "";
  #lineWidth = 1;
  #identity = false;
  readonly #stack: Array<[string, string, number, string, number, boolean]> = [];

  constructor(ctx: Canvas2D) {
    this.ctx = ctx;
    this.reset();
  }

  /** Forgets the cache and sets known values (start of a frame). */
  reset(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.#identity = true;
    ctx.globalAlpha = 1;
    this.#alpha = 1;
    ctx.fillStyle = "#000";
    this.#fill = "#000";
    ctx.strokeStyle = "#000";
    this.#stroke = "#000";
    ctx.lineWidth = 1;
    this.#lineWidth = 1;
    ctx.setLineDash([]);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    this.#font = "";
    this.#stack.length = 0;
  }

  fill(color: string): void {
    if (color !== this.#fill) {
      this.ctx.fillStyle = color;
      this.#fill = color;
    }
  }

  stroke(color: string): void {
    if (color !== this.#stroke) {
      this.ctx.strokeStyle = color;
      this.#stroke = color;
    }
  }

  get alpha(): number {
    return this.#alpha;
  }

  setAlpha(alpha: number): void {
    if (alpha !== this.#alpha) {
      this.ctx.globalAlpha = alpha;
      this.#alpha = alpha;
    }
  }

  font(font: string): void {
    if (font !== this.#font) {
      this.ctx.font = font;
      this.#font = font;
    }
  }

  lineWidth(width: number): void {
    if (width !== this.#lineWidth) {
      this.ctx.lineWidth = width;
      this.#lineWidth = width;
    }
  }

  /** Paths are emitted in device pixels under the identity transform. */
  identity(): void {
    if (!this.#identity) {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.#identity = true;
    }
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.ctx.setTransform(a, b, c, d, e, f);
    this.#identity = a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0;
  }

  save(): void {
    this.ctx.save();
    this.#stack.push([
      this.#fill,
      this.#stroke,
      this.#alpha,
      this.#font,
      this.#lineWidth,
      this.#identity,
    ]);
  }

  restore(): void {
    this.ctx.restore();
    const top = this.#stack.pop();
    if (top) {
      [
        this.#fill,
        this.#stroke,
        this.#alpha,
        this.#font,
        this.#lineWidth,
        this.#identity,
      ] = top;
    }
  }
}
