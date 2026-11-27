// SPDX-License-Identifier: GPL-3.0-or-later

// The stage: what the audience sees. One renderer (docs/adr/0004) draws the
// document through the camera, with the viewing parts of the extensions only.
//
// - A cross-fade is two layers: a still picture of one view over the canvas
//   with the other, with the layer's opacity following the mix. Both views of
//   a cross-fade stand still, so each is drawn once and the fade itself costs
//   no drawing.
// - What a stop hides is laid over the document as the renderer reads it: a
//   hidden element, and what is inside it, reads as gone. The document is not
//   touched.

import type { ElementId } from "@galatsa/core";
import type { Label, ViewHost } from "@galatsa/extension-api";
import type { MessageValues } from "@galatsa/i18n";
import {
  CanvasRenderer,
  type ImageSource,
  type SceneAssets,
  type SceneSource,
} from "@galatsa/renderer";
import { sameView, type Screen } from "./model.ts";
import type { Hidden, Picture, Shot } from "./playback.ts";

export interface StageOptions {
  /** The extension host whose element types draw the elements (viewing parts). */
  readonly host: ViewHost;
  /** The resolved document. */
  readonly scene: SceneSource;
  readonly images?: ImageSource;
  readonly assets?: SceneAssets;
  /** Looks up text that elements draw themselves. */
  readonly t: (label: Label, values?: MessageValues) => string;
  /** CSS colour behind everything; default white. */
  readonly background?: string;
  /** Something changed outside `draw` (the size, an image that arrived): draw again. */
  readonly onInvalidate: () => void;
}

const NOTHING: ReadonlySet<ElementId> = new Set();

/** The document with what a stop hides read as gone. */
class HidingScene implements SceneSource {
  readonly #base: SceneSource;
  /** Hidden elements with everything inside them. */
  hidden: ReadonlySet<ElementId> = NOTHING;

  constructor(base: SceneSource) {
    this.#base = base;
  }

  children(parent: ElementId | null) {
    return this.#base.children(parent);
  }
  parentOf(id: ElementId) {
    return this.#base.parentOf(id);
  }
  isGone(id: ElementId) {
    return this.hidden.has(id) || this.#base.isGone(id);
  }
  isContainer(id: ElementId | null) {
    return this.#base.isContainer(id);
  }
  localPosition(id: ElementId) {
    return this.#base.localPosition(id);
  }
  offset(from: ElementId | null, to: ElementId | null) {
    return this.#base.offset(from, to);
  }
  element(id: ElementId) {
    return this.#base.element(id);
  }
}

function same(a: Shot | null, b: Shot): boolean {
  return a !== null && a.hidden === b.hidden && sameView(a.view, b.view);
}

export class Stage {
  readonly element: HTMLElement;
  readonly renderer: CanvasRenderer;
  readonly #base: SceneSource;
  readonly #scene: HidingScene;
  readonly #layer: HTMLCanvasElement;
  readonly #canvas: HTMLCanvasElement;
  /** What the canvas shows, and what the still layer over it shows. */
  #main: Shot | null = null;
  #still: Shot | null = null;
  /** Hidden sets with everything inside them, until the document changes. */
  #expanded = new WeakMap<Hidden, ReadonlySet<ElementId>>();

  constructor(container: HTMLElement, options: StageOptions) {
    const doc = container.ownerDocument;
    this.element = doc.createElement("div");
    this.element.className = "gp-stage";
    container.append(this.element);
    this.#base = options.scene;
    this.#scene = new HidingScene(options.scene);
    this.renderer = new CanvasRenderer({
      host: options.host,
      ...(options.images ? { images: options.images } : {}),
      ...(options.assets ? { assets: options.assets } : {}),
      t: options.t,
      background: options.background ?? "#ffffff",
      onInvalidate: () => {
        this.invalidate();
        options.onInvalidate();
      },
    });
    this.renderer.setScene(this.#scene);
    this.renderer.mount(this.element);
    this.#canvas = this.element.querySelector("canvas")!;
    this.#layer = doc.createElement("canvas");
    this.#layer.className = "gp-fade";
    this.#layer.hidden = true;
    this.element.append(this.#layer);
  }

  /** The size of the drawing area in CSS pixels. */
  get screen(): Screen {
    const { width, height } = this.renderer.viewport;
    return { width, height };
  }

  /** What is drawn is out of date: the next `draw` draws everything again. */
  invalidate(): void {
    this.#main = null;
    this.#still = null;
  }

  /** The document changed: these elements are read again (the renderer's `applyChanges`). */
  changed(ids: Iterable<ElementId>): void {
    this.#expanded = new WeakMap();
    // What is hidden is worked out again for the new document.
    const hidden = this.#scene.hidden;
    this.#scene.hidden = NOTHING;
    this.renderer.applyChanges([...ids, ...hidden]);
    this.invalidate();
  }

  /** Draws a picture. Nothing is drawn again that is on screen already. */
  draw(picture: Picture): void {
    const layer = this.#layer;
    if (picture.kind === "view") {
      this.#render(picture);
      layer.hidden = true;
      return;
    }
    const { from, to, mix } = picture;
    let opacity = mix;
    if (!(same(this.#still, to) && same(this.#main, from))) {
      if (!same(this.#still, from)) {
        this.#render(from);
        this.#copy();
        this.#still = from;
      }
      this.#render(to);
      opacity = 1 - mix;
    }
    layer.style.opacity = String(opacity);
    layer.hidden = false;
  }

  dispose(): void {
    this.renderer.dispose();
    this.element.remove();
  }

  /** Draws a shot on the canvas, unless it is there. */
  #render(shot: Shot): void {
    if (same(this.#main, shot)) return;
    this.#hide(shot.hidden);
    this.renderer.setCamera(shot.view);
    this.renderer.render();
    this.#main = shot;
  }

  /** Copies the canvas to the still layer. */
  #copy(): void {
    const from = this.#canvas;
    const layer = this.#layer;
    if (layer.width !== from.width) layer.width = from.width;
    if (layer.height !== from.height) layer.height = from.height;
    const ctx = layer.getContext("2d");
    if (ctx === null) return;
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(from, 0, 0);
  }

  /** Makes the renderer read the document with these elements hidden. */
  #hide(hidden: Hidden): void {
    const next = this.#expand(hidden);
    const now = this.#scene.hidden;
    if (next === now) return;
    const changed: ElementId[] = [];
    for (const id of next) if (!now.has(id)) changed.push(id);
    for (const id of now) if (!next.has(id)) changed.push(id);
    this.#scene.hidden = next;
    if (changed.length > 0) this.renderer.applyChanges(changed);
  }

  /**
   * The hidden elements with everything inside them. Hiding a container hides
   * what the user sees inside it; a container that is gone hides nothing
   * (docs/adr/0001, section 6.4).
   */
  #expand(hidden: Hidden): ReadonlySet<ElementId> {
    if (hidden.size === 0) return NOTHING;
    let out = this.#expanded.get(hidden);
    if (out !== undefined) return out;
    const base = this.#base;
    const all = new Set<ElementId>();
    const add = (id: ElementId): void => {
      if (all.has(id)) return;
      all.add(id);
      if (base.isContainer(id)) for (const child of base.children(id)) add(child);
    };
    for (const id of hidden)
      if (base.element(id) !== undefined && !base.isGone(id)) add(id);
    out = all;
    this.#expanded.set(hidden, out);
    return out;
  }
}
