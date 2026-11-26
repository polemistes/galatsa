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
 * Fractional order key. Siblings are sorted by comparing keys as plain strings
 * (UTF-16 code unit order, never locale order), ties broken by id. Section 4.
 */
export type OrderKey = string;
/**
 * Element type id: "<extension id>/<type name>", for example "core/frame" or
 * "galatsa.text/text". Section 3.2.
 */
export type ElementTypeId = string;

/** A JSON value. Numbers must be finite (JSON has no NaN or Infinity). */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// ---------------------------------------------------------------------------
// Type-specific data (section 3.4)
//
// An element's `data` is a map whose values are either plain JSON (replaced as a
// whole, last writer wins) or shared types that merge item by item. In the JSON
// form a shared type is an object with a "$y" tag. A plain JSON object that itself
// has a "$y" key is escaped as { "$y": "json", "value": ... }.
// ---------------------------------------------------------------------------

/** One run of a rich text delta, as in Yjs `Y.Text.toDelta()`. */
export interface TextRun {
  /** Inserted string, or an embedded JSON object (embeds must be plain JSON). */
  insert: string | JsonObject;
  attributes?: JsonObject;
}

/** A shared text (`Y.Text`): rich text as a list of runs. */
export interface YTextValue {
  $y: "text";
  delta: TextRun[];
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
  /** Attribute values are strings or plain JSON. */
  attributes: { [key: string]: Json };
  children: YXmlNode[];
}

/** A text node inside an XML fragment (`Y.XmlText`). */
export interface YXmlTextValue {
  $y: "xmlText";
  delta: TextRun[];
}

export type YXmlNode = YXmlElementValue | YXmlTextValue;

/** Escape for a plain JSON object that has a "$y" key of its own. */
export interface EscapedJsonValue {
  $y: "json";
  value: Json;
}

/** A shared-type value in the JSON form. */
export type YValue =
  | YTextValue
  | YMapValue
  | YArrayValue
  | YXmlFragmentValue
  | YXmlElementValue
  | YXmlTextValue
  | EscapedJsonValue;

/**
 * A value inside an element's `data`: plain JSON or a tagged shared type. Plain
 * objects with a "$y" key never appear unescaped.
 */
export type DataValue = Json | YValue;

/** An element's type-specific data. Opaque to everything but the owning extension. */
export type ElementData = { [key: string]: DataValue };

// ---------------------------------------------------------------------------
// Geometry (section 7)
// ---------------------------------------------------------------------------

/**
 * A position in a container's local coordinate space, tagged with that container.
 * `space` is the element's parent at the time the position was written. Moving an
 * element into another container does not rewrite its position (that would
 * overwrite a concurrent move); it records a Rebase instead. Section 5.3.
 */
export interface Position {
  x: number;
  y: number;
  /** Container whose local space x and y are in; null for the canvas root. */
  space: ElementId | null;
}

/**
 * Translation from the space a position was written in (`from`) to the parent the
 * element was moved into (`to`), recorded when the element changed container:
 * local position in `to` = position in `from` + (dx, dy). Section 5.3.
 */
export interface Rebase {
  from: ElementId | null;
  to: ElementId | null;
  dx: number;
  dy: number;
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
 * How an element was removed. Absent (null) means live.
 * - "delete": the element and its whole subtree are hidden.
 * - "dissolve": only the container itself disappears; its children stay where they
 *   are, as if they belonged to the container's parent. Used for ungroup and for
 *   "remove frame, keep contents". Only containers can be dissolved.
 */
export type Removal = "delete" | "dissolve";

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
  /** Set when the element changed container after `pos` was written; else null. */
  rebase: Rebase | null;
  /** User-visible name; empty string when unnamed. */
  name: string;
  /** Locked elements cannot be selected or changed in the editor. Inherited. */
  locked: boolean;
  /** Assets that `data` refers to, so they are kept even for unknown types. */
  assets: AssetId[];
  removed: Removal | null;
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

export interface Stop {
  name: string;
  view: StopView;
  /** Speaker notes. */
  notes: YTextValue;
  /** Elements shown or hidden on arrival, keyed by element id. */
  visibility: { [element: ElementId]: VisibilityChange };
  /** Transition into this stop, defined by the transition extension; null = default. */
  transition: Json;
  removed: boolean;
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
  removed: boolean;
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

/** Version of the document schema. Equal to the file format version (section 9.4). */
export const SCHEMA_VERSION = 1;

export interface DocumentSnapshot {
  /** Version of the schema this snapshot follows. */
  schemaVersion: number;
  /** Id of the document, stable across saves and copies that are meant to merge. */
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
