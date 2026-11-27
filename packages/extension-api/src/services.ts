// SPDX-License-Identifier: GPL-3.0-or-later

// Editor services: the editor state and queries that commands, tools and panels
// use, so that selection, snapping, guides and text formatting can be written
// as extensions. The editor implements them. See
// docs/adr/0005-extension-interface.md, section 4.8.

import type { CameraView, ElementData, ElementId, Point, Rect } from "@galatsa/core";
import type { ContributionId, Mode } from "./ids.ts";

export interface SelectionService {
  /** Selected elements, in selection order. */
  get(): readonly ElementId[];
  /** Replaces the selection. Not an undo step (the selection is not document content). */
  set(ids: readonly ElementId[]): void;
}

export interface CameraService {
  get(): CameraView;
  /** The part of the canvas the user sees, in root space. */
  viewport(): Rect;
  set(view: CameraView): void;
  /** Moves the camera so that `rect` (in the space of `space`) fills the view. */
  fit(rect: Rect, space: ElementId | null): void;
}

export interface ModeService {
  get(): Mode;
  set(mode: Mode): void;
}

export interface PanelService {
  isOpen(panel: ContributionId): boolean;
  open(panel: ContributionId): void;
  close(panel: ContributionId): void;
}

/** Where an element is, as the user sees it now. */
export interface ElementPlacement {
  /** The container the element is in, as resolved (null for the root). */
  readonly parent: ElementId | null;
  /** Top-left corner of the unrotated box, in the parent's space. */
  readonly x: number;
  readonly y: number;
  /** The same corner in root space. */
  readonly worldX: number;
  readonly worldY: number;
  /** Size of the box; 0 for groups. */
  readonly w: number;
  readonly h: number;
  /** Rotation in radians about the box centre. */
  readonly rot: number;
}

/** Questions about the canvas, answered from the resolved document as the user sees it. */
export interface SceneQuery {
  /** Topmost selectable element at a point in root space, within `tolerance` world units. */
  elementAt(point: Point, tolerance: number): ElementId | null;
  /**
   * Selectable elements in a rectangle in root space (a rubber band): wholly
   * inside it, or touching it.
   */
  elementsIn(rect: Rect, how: "inside" | "touching"): ElementId[];
  /** Bounding box in root space (rotation included), or null if the element is gone. */
  bounds(id: ElementId): Rect | null;
  placement(id: ElementId): ElementPlacement | null;
  /** Elements drawn in the current view, back to front: candidates for snapping and guides. */
  visible(): readonly ElementId[];
}

/** The text being edited in place, and its selection. */
export interface TextEditingState {
  readonly id: ElementId;
  /** Data key of the Y.Text being edited. */
  readonly key: string;
  /** Start of the selection (the caret when `length` is 0), in characters. */
  readonly index: number;
  readonly length: number;
}

export interface TextEditingService {
  /** The text being edited, or null when no text is being edited. */
  current(): TextEditingState | null;
  /** Moves the caret or the selection in the text being edited. */
  select(index: number, length: number): void;
}

/** How an element is drawn during a gesture, instead of what the document says. */
export interface ElementPreview {
  /** Position in the element's parent space. */
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  readonly rot?: number;
  /** Data keys drawn with these values (merged over the element's data). */
  readonly data?: ElementData;
}

export type PreviewChanges = { readonly [id: ElementId]: ElementPreview };

export interface PreviewService {
  /** Draws these elements as described until `clear`, without changing the document. */
  show(changes: PreviewChanges): void;
  clear(): void;
}

/**
 * The editor's services. An open interface: the editor may add more by
 * declaration merging,
 *
 *   declare module "@galatsa/extension-api/editing" {
 *     interface EditorServices { guides: GuideService }
 *   }
 *
 * and extensions that need them depend on the editor's extension.
 */
export interface EditorServices {
  readonly selection: SelectionService;
  readonly camera: CameraService;
  readonly mode: ModeService;
  readonly panels: PanelService;
  readonly scene: SceneQuery;
  readonly text: TextEditingService;
  readonly preview: PreviewService;
}
