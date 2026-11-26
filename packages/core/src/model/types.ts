// SPDX-License-Identifier: GPL-3.0-or-later

// Plain (JSON) form of a Galatsa document. This is what `document.json` in a file
// holds, what viewers receive as a snapshot, and what the Yjs binding
// (`@galatsa/core/ydoc`) converts to and from. The rules behind every field are in
// docs/adr/0001-document-model-and-file-format.md; section numbers below refer to it.
//
// Nothing in this file depends on Yjs, so the player can use these types without
// loading the CRDT library.

/** Unique id of an element (frame, group or extension element). See section 3.1. */
export type ElementId = string;
/** Unique id of a camera stop. */
export type StopId = string;
/** Unique id of a route. */
export type RouteId = string;
/** Unique id of one entry (one visit to a stop) inside a route. */
export type RouteEntryId = string;
/** Content address of an asset: "sha256-" followed by 64 lowercase hex digits. */
export type AssetId = `sha256-${string}`;
/**
 * Fractional order key in the syntax of section 4.1. Siblings are sorted by
 * comparing keys as plain strings (UTF-16 code unit order), ties broken by id.
 */
export type OrderKey = string;
/**
 * Element type id: "<extension id>/<type name>", for example "core/frame" or
 * "galatsa.text/text". Section 3.2.
 */
export type ElementTypeId = string;
/** Random token rewritten by every change of a record (section 5.5). */
export type Revision = string;

/** A JSON value. Numbers must be finite (JSON has no NaN or Infinity). */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// ---------------------------------------------------------------------------
// Type-specific data (section 3.4)
//
// An element's `data` (and every `ext` slot) is a map whose values are either
// plain JSON (replaced as a whole, last writer wins) or shared types that merge
// item by item. In the JSON form a shared type is an object with a "$y" tag. Only
// values in "value positions" (directly in a data or ext map, a shared map, a
// shared array, a text embed or an attribute) are read as tagged; a plain object
// in such a place that has a "$y" key of its own is escaped as
// { "$y": "json", "value": ... }. Anything nested inside plain JSON is plain.
// ---------------------------------------------------------------------------

/** One run of a rich text delta, as in Yjs `Y.Text.toDelta()`. */
export interface TextRun {
  /** Inserted string, an embedded JSON object, or an embedded shared type. */
  insert: string | DataValue;
  /** Formatting attributes (Yjs stores these as JSON). */
  attributes?: JsonObject;
}

/** Attributes set on a shared text or XML node itself (`setAttribute`). */
export type NodeAttributes = { [key: string]: DataValue };

/** A shared text (`Y.Text`): rich text as a list of runs. */
export interface YTextValue {
  $y: "text";
  delta: TextRun[];
  attributes?: NodeAttributes;
}

/** A shared map (`Y.Map`): keys merge independently. */
export interface YMapValue {
  $y: "map";
  entries: { [key: string]: DataValue };
}

/** A shared array (`Y.Array`): concurrent inserts are all kept. */
export interface YArrayValue {
  $y: "array";
  items: DataValue[];
}

/** A shared XML fragment (`Y.XmlFragment`), for editors that use a tree model. */
export interface YXmlFragmentValue {
  $y: "xmlFragment";
  children: YXmlNode[];
}

/** An element inside an XML fragment (`Y.XmlElement`). */
export interface YXmlElementValue {
  $y: "xmlElement";
  name: string;
  attributes: NodeAttributes;
  children: YXmlNode[];
}

/** A text node inside an XML fragment (`Y.XmlText`). */
export interface YXmlTextValue {
  $y: "xmlText";
  delta: TextRun[];
  attributes?: NodeAttributes;
}

/** A hook inside an XML fragment (`Y.XmlHook`, a map with a hook name). */
export interface YXmlHookValue {
  $y: "xmlHook";
  hookName: string;
  entries: { [key: string]: DataValue };
}

export type YXmlNode = YXmlElementValue | YXmlTextValue | YXmlHookValue;

/** Escape for a plain JSON object that has a "$y" key of its own. */
export interface EscapedJsonValue {
  $y: "json";
  value: Json;
}

/**
 * A plain value that JSON cannot express (binary data, undefined, NaN, big
 * integers), as stored by Yjs. `value` is an AnyTree.
 */
export interface AnyValue {
  $y: "any";
  value: AnyTree;
}

/**
 * Lossless tree for non-JSON values. JSON primitives (finite numbers) stand for
 * themselves; every other node is an object with exactly one key:
 * {"a": [...]} array, {"o": {...}} object, {"u": 1} undefined,
 * {"b": "<base64>"} binary, {"n": "NaN" | "Infinity" | "-Infinity"}, {"i": "<digits>"} bigint.
 */
export type AnyTree =
  | null
  | boolean
  | number
  | string
  | { a: AnyTree[] }
  | { o: { [key: string]: AnyTree } }
  | { u: 1 }
  | { b: string }
  | { n: string }
  | { i: string };

/**
 * A value that could not be represented (an unknown shared type). Kept so a save
 * never fails; writing it back yields null (section 3.4).
 */
export interface UnsupportedValue {
  $y: "unsupported";
  note: string;
}

/** A shared-type (or escaped) value in the JSON form. */
export type YValue =
  | YTextValue
  | YMapValue
  | YArrayValue
  | YXmlFragmentValue
  | YXmlElementValue
  | YXmlTextValue
  | YXmlHookValue
  | EscapedJsonValue
  | AnyValue
  | UnsupportedValue;

/** A value in a value position: plain JSON or a tagged value. */
export type DataValue = Json | YValue;

/** An element's type-specific data, or an `ext` slot map. */
export type ElementData = { [key: string]: DataValue };

/**
 * Open slot for additive envelope-level features ("<owner>.<name>" -> value), so
 * they need no new format version. Readers keep keys they do not know (section 9.4).
 */
export type ExtSlots = { [key: string]: DataValue };

// ---------------------------------------------------------------------------
// Geometry (section 7)
// ---------------------------------------------------------------------------

/**
 * A position in a container's local coordinate space, tagged with that container.
 * `space` is the element's effective parent when the position was written. Only
 * moving an element writes its position (section 5.3).
 */
export interface Position {
  x: number;
  y: number;
  /** Container whose local space x and y are in; null for the canvas root. */
  space: ElementId | null;
}

/** A translation from positions written in `from` into the rebase's `to` space. */
export interface Shift {
  from: ElementId | null;
  dx: number;
  dy: number;
}

/**
 * Recorded when an element changes container (section 5.3). It leads to `to`.
 * - `shifts`: a position written in space `from` (not `to`) is moved by (dx, dy).
 *   It lists every space the element was in since its position was last written,
 *   so a concurrent move written in any of them is placed correctly.
 * - `base`: the stored position at the time of the reparent, if it was already in
 *   `to`'s space; that exact position is moved by (dx, dy). A later move writes a
 *   different position, to which `base` no longer applies.
 */
export interface Rebase {
  to: ElementId | null;
  base: { x: number; y: number; dx: number; dy: number } | null;
  shifts: Shift[];
}

/** Width and height in world units. Never negative. */
export interface Size {
  w: number;
  h: number;
}

/** Axis-aligned rectangle: top-left corner and size. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Elements (section 3)
// ---------------------------------------------------------------------------

/**
 * Mark written by a delete (section 5.5) on the deleted element (the root of the
 * delete) and on every descendant the deleting user saw. A record is deleted only
 * while the delete is in effect and the record's `rev` still equals `rev` here.
 */
export interface DeleteMark {
  /** Random id of the delete action. */
  action: string;
  /** The element the user deleted. */
  root: ElementId;
  /** The record's revision when the delete was made. */
  rev: Revision;
}

/** Fields every element has, whatever its type. */
export interface ElementBase {
  type: ElementTypeId;
  /** Version of `data`'s layout, owned by the extension. Integer >= 1. */
  typeVersion: number;
  /** Container (frame or group) this element is in; null for the canvas root. */
  parent: ElementId | null;
  /** Stacking order among siblings; higher keys are drawn in front. */
  order: OrderKey;
  pos: Position;
  /** Set when the element changed container; see Rebase. */
  rebase: Rebase | null;
  /** User-visible name; empty string when unnamed. */
  name: string;
  /** Locked elements cannot be selected or changed in the editor. Inherited. */
  locked: boolean;
  /** Rewritten by every change of the element (section 5.5). */
  rev: Revision;
  /** Set by a delete; see DeleteMark. */
  deleted: DeleteMark | null;
  /** Containers only: dissolved (ungrouped). Beats a concurrent delete. */
  dissolved: boolean;
  /** Ids of elements and stops that `data` or `ext` refer to (section 3.5). */
  refs: string[];
  /** Additive envelope-level features (section 9.4). */
  ext: ExtSlots;
  data: ElementData;
}

export const FRAME_TYPE = "core/frame";
export const GROUP_TYPE = "core/group";

/** A frame: a named, visible rectangle that contains elements and can be a stop. */
export interface FrameElement extends ElementBase {
  type: typeof FRAME_TYPE;
  size: Size;
}

/** Keys of a frame's `data` defined by core. Others may be added later. */
export interface FrameData {
  /** Clip children to the frame's rectangle. */
  clip?: boolean;
  /** CSS color of the background, or null for none. */
  fill?: string | null;
  /** CSS color of the outline, or null for none. */
  stroke?: string | null;
}

/** A group: an invisible container whose bounds are the union of its children. */
export interface GroupElement extends ElementBase {
  type: typeof GROUP_TYPE;
}

/** An element whose type comes from an extension (known or not). */
export interface ExtensionElement extends ElementBase {
  size: Size;
  /** Rotation in radians about the centre, clockwise on screen (y points down). */
  rot: number;
}

export type Element = FrameElement | GroupElement | ExtensionElement;
export type ContainerElement = FrameElement | GroupElement;

// ---------------------------------------------------------------------------
// Stops and routes (section 6)
// ---------------------------------------------------------------------------

/** A stop that shows a frame. It follows the frame when the frame moves. */
export interface FrameView {
  kind: "frame";
  frame: ElementId;
  /** Margin around the frame, as a fraction of the frame's larger side. */
  padding: number;
}

/** A stop that shows a free rectangle, in the local space of a container. */
export interface RectView {
  kind: "rect";
  /** Container whose local space the rectangle is in; null for the root. */
  space: ElementId | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a stop shows: a region, not a camera pose. The player fits it to the screen. */
export type StopView = FrameView | RectView;

/** What happens to an element when the presentation arrives at a stop. */
export interface VisibilityChange {
  action: "show" | "hide";
}

/** Removal of a stop or route: in effect while the record's rev equals `rev`. */
export interface RemovalMark {
  rev: Revision;
}

export interface Stop {
  name: string;
  view: StopView;
  /** Speaker notes. */
  notes: YTextValue;
  /** Elements shown or hidden on arrival, keyed by element id. */
  visibility: { [element: ElementId]: VisibilityChange };
  /** Transition into this stop, defined by the transition extension; null = default. */
  transition: Json;
  rev: Revision;
  removed: RemovalMark | null;
  ext: ExtSlots;
}

/** One visit to a stop. The same stop may appear in many routes, and more than once. */
export interface RouteEntry {
  stop: StopId;
  order: OrderKey;
}

export interface Route {
  name: string;
  /** Order of the route in the list of routes. */
  order: OrderKey;
  entries: { [entry: RouteEntryId]: RouteEntry };
  rev: Revision;
  removed: RemovalMark | null;
  ext: ExtSlots;
}

// ---------------------------------------------------------------------------
// Assets (section 8)
// ---------------------------------------------------------------------------

/** Description of an asset. The bytes are stored outside the document. */
export interface AssetInfo {
  /** IANA media type, for example "image/png". */
  mediaType: string;
  byteLength: number;
  /** Original file name, for display only. */
  name?: string;
  /** Pixel size of images and video, if known. */
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// The document (section 2)
// ---------------------------------------------------------------------------

/** The format and schema version this code writes (section 9.4). */
export const SCHEMA_VERSION = 1;
/** The oldest reader version that can read what this code writes. */
export const MIN_READER_VERSION = 1;

export interface DocumentSnapshot {
  /** Format version of the content (the highest version that wrote it). */
  schemaVersion: number;
  /** Readers older than this must refuse the document. */
  minReaderVersion: number;
  /** Id of the document; copies of one presentation share it. */
  id: string;
  title: string;
  /** Document-wide settings, keyed "<owner>.<name>". Plain JSON. */
  settings: JsonObject;
  elements: { [id: ElementId]: Element };
  stops: { [id: StopId]: Stop };
  routes: { [id: RouteId]: Route };
  assets: { [id: AssetId]: AssetInfo };
}

/** True for frames and groups, the only elements that can contain others. */
export function isContainer(element: Element): element is ContainerElement {
  return element.type === FRAME_TYPE || element.type === GROUP_TYPE;
}

export function isFrame(element: Element): element is FrameElement {
  return element.type === FRAME_TYPE;
}

export function isGroup(element: Element): element is GroupElement {
  return element.type === GROUP_TYPE;
}

/** Sets an own property, also for keys like "__proto__" (section 3.1). */
export function setOwn<T>(target: { [key: string]: T }, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Reads an own property only (never the prototype chain). */
export function getOwn<T>(
  target: { readonly [key: string]: T },
  key: string,
): T | undefined {
  return Object.hasOwn(target, key) ? target[key] : undefined;
}
