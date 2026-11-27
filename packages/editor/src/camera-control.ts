// SPDX-License-Identifier: GPL-3.0-or-later

// The editor's camera controls (docs/adr/0009-camera.md): every camera the
// editor sets is anchored in the innermost frame around its centre and kept
// within the zoom limits (anchor.ts); the camera follows its anchor when that
// moves, so the view stays where it is on screen; zoom about a point on
// screen, panning and pinching; the pointer in the camera's own space for
// tools; and the hand (Space held down: a drag moves the canvas instead of
// using the tool).

import {
  clampZoom,
  maxPreciseZoom,
  type CameraView,
  type LiveResolver,
  type Point,
} from "@galatsa/core";
import type { Cursor, SpacePoint } from "@galatsa/extension-api/editing";
import {
  Anchoring,
  follow,
  pin,
  sceneAnchorSource,
  type AnchorSource,
  type Pin,
} from "./anchor.ts";
import {
  panBy,
  screenToCamera,
  worldToScreen,
  zoomAbout,
  type Placement,
  type ScreenSize,
} from "./camera.ts";
import type { EditorScene } from "./scene-source.ts";

/** What the camera controls need from the editor. */
export interface CameraHost {
  readonly live: LiveResolver;
  readonly scene: EditorScene;
  screen(): ScreenSize;
  camera(): CameraView;
  /** Sets the camera through the camera service (which calls `place`). */
  setCamera(view: CameraView): void;
  /** The hand's cursor changed. */
  cursorChanged(): void;
}

export class CameraControl {
  readonly #host: CameraHost;
  readonly #src: AnchorSource;
  readonly #anchoring: Anchoring;
  readonly #placement: Placement;
  #pin: Pin | null = null;
  /** The last pointer position given to a tool, on screen and in root space. */
  #pointer: { screen: Point; world: Point } | null = null;
  /** Space is held down. */
  #handHeld = false;
  /** Where the hand's drag is now, on screen, while it drags. */
  #handAt: Point | null = null;

  constructor(host: CameraHost) {
    this.#host = host;
    this.#src = sceneAnchorSource(host.live, host.scene);
    this.#anchoring = new Anchoring(this.#src);
    this.#placement = {
      anchor: (view) => this.#anchoring.anchor(view),
      offset: (from, to) => host.scene.offset(from, to),
    };
  }

  /** The camera as it is set: anchored, within the zoom limits, and pinned to its anchor. */
  place(view: CameraView): CameraView {
    // The pointer's screen position no longer stands for its root point.
    this.#pointer = null;
    const anchored = this.#anchoring.anchor(view);
    const zoom = clampZoom(anchored.zoom, anchored.cx, anchored.cy);
    const placed = zoom === anchored.zoom ? anchored : { ...anchored, zoom };
    this.#pin = pin(this.#src, placed.space);
    return placed;
  }

  /** The document changed: frames may have come, gone or moved. */
  documentChanged(): void {
    this.#anchoring.invalidate();
    this.follow();
  }

  /**
   * The anchor (or a container above it) may have moved, or gone into another
   * container: shift the camera by as much, so the view stays where it is on
   * screen (anchor.ts, `follow`). Never through root coordinates.
   *
   * When following would break the precision budget wherever the view could
   * be anchored (the frame being looked at deep down was moved very far), the
   * camera stays with the frame instead, and its pin is kept, so undoing the
   * move finds the view as it was, at the same zoom.
   */
  follow(): void {
    const camera = this.#host.camera();
    if (camera.space === null) return;
    const pinned = this.#pin;
    if (pinned === null || pinned.space !== camera.space) {
      this.#host.setCamera(camera);
      return;
    }
    const next = follow(this.#src, pinned, camera);
    if (next === camera) {
      // A deleted frame anchors only while the budget breaks elsewhere.
      if (this.#src.isGone(camera.space)) this.#host.setCamera(camera);
      return;
    }
    if (next.space === camera.space) {
      const anchored = this.#anchoring.anchor(next);
      if (anchored.zoom > maxPreciseZoom(anchored.cx, anchored.cy)) return;
    }
    this.#host.setCamera(next);
  }

  zoomAt(point: Point, factor: number): void {
    const camera = this.#host.camera();
    const next = zoomAbout(camera, this.#host.screen(), point, factor, this.#placement);
    if (next !== camera) this.#host.setCamera(next);
  }

  pan(dx: number, dy: number): void {
    this.#host.setCamera(panBy(this.#host.camera(), dx, dy));
  }

  /**
   * Two fingers moved: the point that was between them at `from` is between
   * them at `to`, and the view is scaled by how much they spread.
   */
  pinch(from: Point, to: Point, factor: number): void {
    if (factor !== 1) this.zoomAt(from, factor);
    if (to.x !== from.x || to.y !== from.y) this.pan(to.x - from.x, to.y - from.y);
  }

  /** A point on screen in the camera's own space (exact at any zoom). */
  pointAt(screen: Point): SpacePoint {
    const camera = this.#host.camera();
    const p = screenToCamera(camera, this.#host.screen(), screen);
    return { space: camera.space, x: p.x, y: p.y };
  }

  /** The pointer position a tool was just given. */
  notePointer(screen: Point, world: Point): void {
    this.#pointer = { screen, world };
  }

  /**
   * A point of root space on screen. The pointer's own position (the `world`
   * of the last pointer event) maps back to where the pointer is exactly, so a
   * click hits what is under it even where root coordinates cannot resolve a
   * pixel.
   */
  toScreen(world: Point): Point {
    const last = this.#pointer;
    if (last !== null && last.world.x === world.x && last.world.y === world.y)
      return last.screen;
    return worldToScreen(
      this.#host.camera(),
      this.#host.screen(),
      (a, b) => this.#host.scene.offset(a, b),
      world,
    );
  }

  // -------------------------------------------------------------------------
  // The hand: Space held down
  // -------------------------------------------------------------------------

  /** The cursor while the hand is out, or null. */
  get handCursor(): Cursor | null {
    if (this.#handAt !== null) return "grabbing";
    return this.#handHeld ? "grab" : null;
  }

  /** Whether Space is held down. */
  get handHeld(): boolean {
    return this.#handHeld;
  }

  /** Space went down (`busy`: a tool's drag is in progress, which keeps the pointer). */
  holdHand(busy: boolean): boolean {
    if (this.#handHeld) return true;
    if (busy) return false;
    this.#handHeld = true;
    this.#host.cursorChanged();
    return true;
  }

  /** Space went up, or the canvas lost focus. A drag in progress goes on until the pointer is up. */
  releaseHand(): boolean {
    if (!this.#handHeld) return false;
    this.#handHeld = false;
    this.#host.cursorChanged();
    return true;
  }

  /** A pointer went down: true if the hand takes it. */
  handDown(screen: Point): boolean {
    if (!this.#handHeld) return false;
    this.#handAt = screen;
    this.#host.cursorChanged();
    return true;
  }

  /** The pointer moved: true if the hand has it. */
  handMove(screen: Point): boolean {
    const at = this.#handAt;
    if (at === null) return false;
    this.#handAt = screen;
    if (screen.x !== at.x || screen.y !== at.y)
      this.pan(screen.x - at.x, screen.y - at.y);
    return true;
  }

  /** The pointer went up (or was cancelled): true if the hand had it. */
  handUp(screen: Point | null): boolean {
    if (this.#handAt === null) return false;
    if (screen !== null) this.handMove(screen);
    this.#handAt = null;
    this.#host.cursorChanged();
    return true;
  }
}
