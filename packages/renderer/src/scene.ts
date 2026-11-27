// SPDX-License-Identifier: GPL-3.0-or-later

// What the renderer reads from the document, and nothing more. The renderer never
// sees Yjs: it reads the resolved document through this interface, which the
// Resolver of @galatsa/core already has (effective parent, children in drawing
// order, gone or not, local position, offsets between spaces), plus the element
// record for what is drawn (type, layout version, data, size, rotation).
//
// Changes arrive as sets of element ids per transaction (added, changed or
// removed); the renderer reads those ids again. A live resolver that is kept up
// to date by the document can implement this interface as it is. Until one
// exists, sceneFromSnapshot() makes a new one for the whole document, and the
// caller reports every id as changed.

import {
  lookupFromRecord,
  Resolver,
  type DocumentSnapshot,
  type ElementData,
  type ElementId,
  type Point,
  type Size,
} from "@galatsa/core";

/** The parts of an element the renderer draws. */
export interface SceneElement {
  readonly type: string;
  readonly typeVersion: number;
  readonly data: ElementData;
  /** Frames and extension elements have a size; groups have none. */
  readonly size?: Size | undefined;
  /** Radians about the centre, clockwise on screen. Extension elements only. */
  readonly rot?: number | undefined;
}

/**
 * Read access to one resolved state of the document. Every method answers for
 * the effective tree (section 5.1 of docs/adr/0001).
 */
export interface SceneSource {
  /** Children in drawing order (back to front), gone ones included. */
  children(parent: ElementId | null): readonly ElementId[];
  /** Effective parent; null for the root. */
  parentOf(id: ElementId): ElementId | null;
  /** Gone (deleted, dissolved, purged): not drawn; a gone container is transparent. */
  isGone(id: ElementId): boolean;
  /** Frame or group. */
  isContainer(id: ElementId | null): boolean;
  /** Position of the element's origin in its effective parent's space. */
  localPosition(id: ElementId): Point;
  /**
   * Offset from the origin of space `to` to the origin of space `from`, computed
   * through the lowest common ancestor so it stays precise far from the origin.
   */
  offset(from: ElementId | null, to: ElementId | null): Point;
  /** The element's record, or undefined if there is no such element. */
  element(id: ElementId): SceneElement | undefined;
}

/** The asset descriptions the renderer needs: the pixel size of images. */
export interface SceneAssets {
  /** Pixel size of an image asset, if the document describes it. */
  imageSize(asset: string): Size | undefined;
}

/**
 * A scene source over a Resolver and a function that gives the element records.
 * The Resolver must be for the same state as the records.
 */
export function sceneFromResolver(
  resolver: Resolver,
  element: (id: ElementId) => SceneElement | undefined,
): SceneSource {
  return {
    children: (parent) => resolver.children(parent),
    parentOf: (id) => resolver.parentOf(id),
    isGone: (id) => resolver.isGone(id),
    isContainer: (id) => resolver.isContainer(id),
    localPosition: (id) => resolver.localPosition(id),
    offset: (from, to) => resolver.offset(from, to),
    element,
  };
}

/**
 * A scene source for a whole document snapshot, with a new Resolver. Use it until
 * the document offers a live resolver, and report every element id as changed.
 */
export function sceneFromSnapshot(
  snapshot: Pick<DocumentSnapshot, "elements">,
): SceneSource {
  const elements = snapshot.elements;
  const resolver = new Resolver(lookupFromRecord(elements));
  return sceneFromResolver(resolver, (id) =>
    Object.hasOwn(elements, id) ? elements[id] : undefined,
  );
}

/** Asset sizes from a snapshot's asset descriptions. */
export function assetsFromSnapshot(
  snapshot: Pick<DocumentSnapshot, "assets">,
): SceneAssets {
  const assets = snapshot.assets;
  return {
    imageSize(asset) {
      if (!Object.hasOwn(assets, asset)) return undefined;
      const info = assets[asset as keyof typeof assets];
      return info?.width !== undefined && info.height !== undefined
        ? { w: info.width, h: info.height }
        : undefined;
    },
  };
}
