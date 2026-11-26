// SPDX-License-Identifier: GPL-3.0-or-later

// Structural validation of a document snapshot read from outside (a file, the
// network). It checks shapes, types and key syntax, not references: dangling
// parents, stops and assets are legal and handled by resolution (section 5).
// Section 9.6 of docs/adr/0001-document-model-and-file-format.md.

import { isValidOrderKey } from "./order.ts";
import { FRAME_TYPE, GROUP_TYPE, type DocumentSnapshot } from "./types.ts";

export const ASSET_ID_PATTERN = /^sha256-[0-9a-f]{64}$/;
export const ELEMENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
/**
 * Ids are opaque, 1 to 64 characters from the URL-safe base64 alphabet, and never
 * "__proto__" (which some JSON tools treat specially).
 */
export const ID_PATTERN = /^(?!__proto__$)[A-Za-z0-9_-]{1,64}$/;
/** Deepest nesting of arrays and objects accepted anywhere in a document. */
export const MAX_DEPTH = 256;

type Problems = string[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isIdOrNull(value: unknown): boolean {
  return value === null || isId(value);
}

/**
 * Deepest nesting of `value`, computed without recursion so that hostile input
 * cannot overflow the stack. Stops counting at `limit + 1`.
 */
export function nestingDepth(value: unknown, limit = MAX_DEPTH): number {
  let max = 0;
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop()!;
    if (typeof item !== "object" || item === null) continue;
    if (depth + 1 > max) max = depth + 1;
    if (max > limit) return max;
    for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return max;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  problems: Problems,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${path}.${key}: unknown field`);
  }
}

function checkJson(value: unknown, path: string, problems: Problems): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) problems.push(`${path}: number is not finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkJson(item, `${path}[${i}]`, problems));
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value))
      checkJson(item, `${path}.${key}`, problems);
    return;
  }
  problems.push(`${path}: not a JSON value`);
}

function checkAnyTree(value: unknown, path: string, problems: Problems): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) problems.push(`${path}: number is not finite`);
    return;
  }
  if (!isObject(value) || Object.keys(value).length !== 1) {
    problems.push(`${path}: invalid any-tree node`);
    return;
  }
  const [key, inner] = Object.entries(value)[0]!;
  switch (key) {
    case "a":
      if (!Array.isArray(inner)) problems.push(`${path}.a: must be an array`);
      else inner.forEach((item, i) => checkAnyTree(item, `${path}.a[${i}]`, problems));
      return;
    case "o":
      if (!isObject(inner)) problems.push(`${path}.o: must be an object`);
      else
        for (const [k, item] of Object.entries(inner))
          checkAnyTree(item, `${path}.o.${k}`, problems);
      return;
    case "u":
      if (inner !== 1) problems.push(`${path}.u: must be 1`);
      return;
    case "b":
      if (typeof inner !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(inner)) {
        problems.push(`${path}.b: must be base64`);
      }
      return;
    case "n":
      if (inner !== "NaN" && inner !== "Infinity" && inner !== "-Infinity") {
        problems.push(`${path}.n: must be NaN, Infinity or -Infinity`);
      }
      return;
    case "i":
      if (typeof inner !== "string" || !/^-?\d+$/.test(inner))
        problems.push(`${path}.i: must be digits`);
      return;
    default:
      problems.push(`${path}: unknown any-tree node ${JSON.stringify(key)}`);
  }
}

function checkAttributes(value: unknown, path: string, problems: Problems): void {
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  for (const [key, item] of Object.entries(value))
    checkDataValue(item, `${path}.${key}`, problems);
}

function checkDelta(value: unknown, path: string, problems: Problems): void {
  if (!Array.isArray(value)) return void problems.push(`${path}: delta must be an array`);
  value.forEach((run, i) => {
    const at = `${path}[${i}]`;
    if (!isObject(run)) return void problems.push(`${at}: run must be an object`);
    onlyKeys(run, ["insert", "attributes"], at, problems);
    if (typeof run.insert !== "string") {
      if (!isObject(run.insert))
        problems.push(`${at}.insert: must be a string or an object`);
      else checkDataValue(run.insert, `${at}.insert`, problems);
    }
    if (run.attributes !== undefined) {
      if (!isObject(run.attributes)) problems.push(`${at}.attributes: must be an object`);
      else checkJson(run.attributes, `${at}.attributes`, problems);
    }
  });
}

function checkXmlNode(value: unknown, path: string, problems: Problems): void {
  if (!isObject(value)) return void problems.push(`${path}: XML node must be an object`);
  if (value.$y === "xmlText") {
    checkDelta(value.delta, `${path}.delta`, problems);
    if (value.attributes !== undefined)
      checkAttributes(value.attributes, `${path}.attributes`, problems);
    return;
  }
  if (value.$y === "xmlHook") {
    if (typeof value.hookName !== "string")
      problems.push(`${path}.hookName: must be a string`);
    if (!isObject(value.entries))
      return void problems.push(`${path}.entries: must be an object`);
    for (const [key, item] of Object.entries(value.entries)) {
      checkDataValue(item, `${path}.entries.${key}`, problems);
    }
    return;
  }
  if (value.$y !== "xmlElement") return void problems.push(`${path}: unknown XML node`);
  if (typeof value.name !== "string" || value.name === "") {
    problems.push(`${path}.name: must be a non-empty string`);
  }
  checkAttributes(value.attributes, `${path}.attributes`, problems);
  checkXmlChildren(value.children, `${path}.children`, problems);
}

function checkXmlChildren(value: unknown, path: string, problems: Problems): void {
  if (!Array.isArray(value)) return void problems.push(`${path}: must be an array`);
  value.forEach((child, i) => checkXmlNode(child, `${path}[${i}]`, problems));
}

/**
 * Checks a value in a value position: plain JSON or a tagged value. Anything
 * nested inside plain JSON is plain JSON, "$y" keys included.
 */
export function checkDataValue(value: unknown, path: string, problems: Problems): void {
  if (!isObject(value) || !("$y" in value)) return checkJson(value, path, problems);
  switch (value.$y) {
    case "json":
      return checkJson(value.value, `${path}.value`, problems);
    case "any":
      return checkAnyTree(value.value, `${path}.value`, problems);
    case "unsupported":
      if (typeof value.note !== "string") problems.push(`${path}.note: must be a string`);
      return;
    case "text":
      checkDelta(value.delta, `${path}.delta`, problems);
      if (value.attributes !== undefined)
        checkAttributes(value.attributes, `${path}.attributes`, problems);
      return;
    case "map":
      if (!isObject(value.entries))
        return void problems.push(`${path}.entries: must be an object`);
      for (const [key, item] of Object.entries(value.entries)) {
        checkDataValue(item, `${path}.entries.${key}`, problems);
      }
      return;
    case "array":
      if (!Array.isArray(value.items))
        return void problems.push(`${path}.items: must be an array`);
      value.items.forEach((item, i) =>
        checkDataValue(item, `${path}.items[${i}]`, problems),
      );
      return;
    case "xmlFragment":
      return checkXmlChildren(value.children, `${path}.children`, problems);
    case "xmlElement":
    case "xmlText":
    case "xmlHook":
      return checkXmlNode(value, path, problems);
    default:
      problems.push(`${path}.$y: unknown shared type ${JSON.stringify(value.$y)}`);
  }
}

function checkSlots(value: unknown, path: string, problems: Problems): void {
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  for (const [key, item] of Object.entries(value))
    checkDataValue(item, `${path}.${key}`, problems);
}

function checkPosition(value: unknown, path: string, problems: Problems): void {
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  onlyKeys(value, ["x", "y", "space"], path, problems);
  if (!isFiniteNumber(value.x)) problems.push(`${path}.x: must be a finite number`);
  if (!isFiniteNumber(value.y)) problems.push(`${path}.y: must be a finite number`);
  if (!isIdOrNull(value.space)) problems.push(`${path}.space: must be an id or null`);
}

function checkRebase(value: unknown, path: string, problems: Problems): void {
  if (value === null) return;
  if (!isObject(value)) return void problems.push(`${path}: must be an object or null`);
  onlyKeys(value, ["to", "base", "shifts"], path, problems);
  if (!isIdOrNull(value.to)) problems.push(`${path}.to: must be an id or null`);
  if (value.base !== null) {
    if (!isObject(value.base)) problems.push(`${path}.base: must be an object or null`);
    else {
      onlyKeys(value.base, ["x", "y", "dx", "dy"], `${path}.base`, problems);
      for (const key of ["x", "y", "dx", "dy"] as const) {
        if (!isFiniteNumber(value.base[key]))
          problems.push(`${path}.base.${key}: must be a finite number`);
      }
    }
  }
  if (!Array.isArray(value.shifts) || value.shifts.length > 64) {
    return void problems.push(`${path}.shifts: must be an array of at most 64 shifts`);
  }
  value.shifts.forEach((shift: unknown, i: number) => {
    const at = `${path}.shifts[${i}]`;
    if (!isObject(shift)) return void problems.push(`${at}: must be an object`);
    onlyKeys(shift, ["from", "dx", "dy"], at, problems);
    if (!isIdOrNull(shift.from)) problems.push(`${at}.from: must be an id or null`);
    if (!isFiniteNumber(shift.dx) || !isFiniteNumber(shift.dy))
      problems.push(`${at}: dx and dy must be finite numbers`);
  });
}

function checkSize(value: unknown, path: string, problems: Problems): void {
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  onlyKeys(value, ["w", "h"], path, problems);
  for (const key of ["w", "h"] as const) {
    const v = value[key];
    if (!isFiniteNumber(v) || v < 0)
      problems.push(`${path}.${key}: must be a finite number >= 0`);
  }
}

function checkRev(value: unknown, path: string, problems: Problems): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    problems.push(`${path}: must be a non-empty string of at most 64 characters`);
  }
}

function checkOrder(value: unknown, path: string, problems: Problems): void {
  if (typeof value !== "string" || !isValidOrderKey(value))
    problems.push(`${path}: not a valid order key`);
}

function checkRemovalMark(value: unknown, path: string, problems: Problems): void {
  if (value === null) return;
  if (!isObject(value)) return void problems.push(`${path}: must be an object or null`);
  onlyKeys(value, ["rev"], path, problems);
  checkRev(value.rev, `${path}.rev`, problems);
}

const ENVELOPE_KEYS = [
  "type",
  "typeVersion",
  "parent",
  "order",
  "pos",
  "rebase",
  "name",
  "locked",
  "rev",
  "deleted",
  "dissolved",
  "refs",
  "ext",
  "data",
];

function checkElement(id: string, value: unknown, problems: Problems): void {
  const path = `elements.${id}`;
  if (!ID_PATTERN.test(id)) problems.push(`${path}: invalid id`);
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  const container = value.type === FRAME_TYPE || value.type === GROUP_TYPE;
  const allowed = [...ENVELOPE_KEYS];
  if (value.type !== GROUP_TYPE) allowed.push("size");
  if (!container) allowed.push("rot");
  onlyKeys(value, allowed, path, problems);
  if (typeof value.type !== "string" || !ELEMENT_TYPE_PATTERN.test(value.type)) {
    problems.push(`${path}.type: invalid element type id`);
  }
  if (!Number.isInteger(value.typeVersion) || (value.typeVersion as number) < 1) {
    problems.push(`${path}.typeVersion: must be an integer >= 1`);
  }
  if (!isIdOrNull(value.parent)) problems.push(`${path}.parent: must be an id or null`);
  checkOrder(value.order, `${path}.order`, problems);
  checkPosition(value.pos, `${path}.pos`, problems);
  checkRebase(value.rebase, `${path}.rebase`, problems);
  if (typeof value.name !== "string") problems.push(`${path}.name: must be a string`);
  if (typeof value.locked !== "boolean")
    problems.push(`${path}.locked: must be a boolean`);
  checkRev(value.rev, `${path}.rev`, problems);
  if (value.deleted !== null) {
    const mark = value.deleted;
    if (!isObject(mark)) problems.push(`${path}.deleted: must be an object or null`);
    else {
      onlyKeys(mark, ["action", "root", "rev"], `${path}.deleted`, problems);
      checkRev(mark.action, `${path}.deleted.action`, problems);
      if (!isId(mark.root)) problems.push(`${path}.deleted.root: must be an id`);
      checkRev(mark.rev, `${path}.deleted.rev`, problems);
    }
  }
  if (typeof value.dissolved !== "boolean")
    problems.push(`${path}.dissolved: must be a boolean`);
  else if (value.dissolved && !container)
    problems.push(`${path}.dissolved: only frames and groups can be dissolved`);
  if (!Array.isArray(value.refs) || !value.refs.every(isId)) {
    problems.push(`${path}.refs: must be an array of ids`);
  }
  if (value.type !== GROUP_TYPE) checkSize(value.size, `${path}.size`, problems);
  if (!container && !isFiniteNumber(value.rot))
    problems.push(`${path}.rot: must be a finite number`);
  checkSlots(value.ext, `${path}.ext`, problems);
  checkSlots(value.data, `${path}.data`, problems);
}

function checkStop(id: string, value: unknown, problems: Problems): void {
  const path = `stops.${id}`;
  if (!ID_PATTERN.test(id)) problems.push(`${path}: invalid id`);
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  onlyKeys(
    value,
    ["name", "view", "notes", "visibility", "transition", "rev", "removed", "ext"],
    path,
    problems,
  );
  if (typeof value.name !== "string") problems.push(`${path}.name: must be a string`);
  const view = value.view;
  if (!isObject(view)) problems.push(`${path}.view: must be an object`);
  else if (view.kind === "frame") {
    onlyKeys(view, ["kind", "frame", "padding"], `${path}.view`, problems);
    if (!isId(view.frame)) problems.push(`${path}.view.frame: must be an id`);
    if (!isFiniteNumber(view.padding) || view.padding < 0) {
      problems.push(`${path}.view.padding: must be a finite number >= 0`);
    }
  } else if (view.kind === "rect") {
    onlyKeys(view, ["kind", "space", "x", "y", "w", "h"], `${path}.view`, problems);
    if (!isIdOrNull(view.space))
      problems.push(`${path}.view.space: must be an id or null`);
    for (const key of ["x", "y"] as const) {
      if (!isFiniteNumber(view[key]))
        problems.push(`${path}.view.${key}: must be a finite number`);
    }
    for (const key of ["w", "h"] as const) {
      const v = view[key];
      if (!isFiniteNumber(v) || v <= 0)
        problems.push(`${path}.view.${key}: must be a finite number > 0`);
    }
  } else problems.push(`${path}.view.kind: must be "frame" or "rect"`);
  if (!isObject(value.notes) || value.notes.$y !== "text") {
    problems.push(`${path}.notes: must be a shared text`);
  } else checkDataValue(value.notes, `${path}.notes`, problems);
  if (!isObject(value.visibility)) problems.push(`${path}.visibility: must be an object`);
  else {
    for (const [element, change] of Object.entries(value.visibility)) {
      if (!isObject(change) || (change.action !== "show" && change.action !== "hide")) {
        problems.push(`${path}.visibility.${element}: action must be "show" or "hide"`);
      } else onlyKeys(change, ["action"], `${path}.visibility.${element}`, problems);
    }
  }
  checkJson(value.transition, `${path}.transition`, problems);
  checkRev(value.rev, `${path}.rev`, problems);
  checkRemovalMark(value.removed, `${path}.removed`, problems);
  checkSlots(value.ext, `${path}.ext`, problems);
}

function checkRoute(id: string, value: unknown, problems: Problems): void {
  const path = `routes.${id}`;
  if (!ID_PATTERN.test(id)) problems.push(`${path}: invalid id`);
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  onlyKeys(value, ["name", "order", "entries", "rev", "removed", "ext"], path, problems);
  if (typeof value.name !== "string") problems.push(`${path}.name: must be a string`);
  checkOrder(value.order, `${path}.order`, problems);
  checkRev(value.rev, `${path}.rev`, problems);
  checkRemovalMark(value.removed, `${path}.removed`, problems);
  checkSlots(value.ext, `${path}.ext`, problems);
  if (!isObject(value.entries))
    return void problems.push(`${path}.entries: must be an object`);
  for (const [entryId, entry] of Object.entries(value.entries)) {
    const at = `${path}.entries.${entryId}`;
    if (!ID_PATTERN.test(entryId)) problems.push(`${at}: invalid id`);
    if (!isObject(entry) || !isId(entry.stop)) {
      problems.push(`${at}: must have a stop id`);
      continue;
    }
    onlyKeys(entry, ["stop", "order"], at, problems);
    checkOrder(entry.order, `${at}.order`, problems);
  }
}

function checkAsset(id: string, value: unknown, problems: Problems): void {
  const path = `assets.${id}`;
  if (!ASSET_ID_PATTERN.test(id)) problems.push(`${path}: invalid asset id`);
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  onlyKeys(
    value,
    ["mediaType", "byteLength", "name", "width", "height", "external"],
    path,
    problems,
  );
  if (value.external !== undefined) {
    const external = value.external;
    if (
      !isObject(external) ||
      typeof external.path !== "string" ||
      !isPlainFileName(external.path)
    ) {
      problems.push(`${path}.external: must be { path } with a plain file name`);
    } else onlyKeys(external, ["path"], `${path}.external`, problems);
  }
  if (typeof value.mediaType !== "string" || !value.mediaType.includes("/")) {
    problems.push(`${path}.mediaType: must be a media type`);
  }
  if (!Number.isInteger(value.byteLength) || (value.byteLength as number) < 0) {
    problems.push(`${path}.byteLength: must be an integer >= 0`);
  }
  if (value.name !== undefined && typeof value.name !== "string") {
    problems.push(`${path}.name: must be a string`);
  }
  for (const key of ["width", "height"] as const) {
    if (value[key] !== undefined && !isFiniteNumber(value[key])) {
      problems.push(`${path}.${key}: must be a finite number`);
    }
  }
}

/** A file name without folders, drive letters or special names. */
function isPlainFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    [...name].every((ch) => ch >= " " && ch !== "/" && ch !== "\\" && ch !== ":") &&
    name !== "." &&
    name !== ".."
  );
}

function checkRecord(
  value: unknown,
  path: string,
  problems: Problems,
  check: (id: string, item: unknown, problems: Problems) => void,
): void {
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  for (const [id, item] of Object.entries(value)) check(id, item, problems);
}

/** Problems found in a snapshot; an empty list means it is structurally valid. */
export function validateSnapshot(value: unknown): string[] {
  if (nestingDepth(value) > MAX_DEPTH)
    return [`document: nested deeper than ${MAX_DEPTH} levels`];
  const problems: Problems = [];
  if (!isObject(value)) return ["document: must be an object"];
  onlyKeys(
    value,
    [
      "schemaVersion",
      "minReaderVersion",
      "id",
      "title",
      "settings",
      "elements",
      "stops",
      "routes",
      "assets",
    ],
    "document",
    problems,
  );
  if (!Number.isInteger(value.schemaVersion) || (value.schemaVersion as number) < 1) {
    problems.push("schemaVersion: must be an integer >= 1");
  }
  if (
    !Number.isInteger(value.minReaderVersion) ||
    (value.minReaderVersion as number) < 1 ||
    (value.minReaderVersion as number) > (value.schemaVersion as number)
  ) {
    problems.push("minReaderVersion: must be an integer from 1 to schemaVersion");
  }
  if (!isId(value.id)) problems.push("id: invalid id");
  if (typeof value.title !== "string") problems.push("title: must be a string");
  if (!isObject(value.settings)) problems.push("settings: must be an object");
  else checkJson(value.settings, "settings", problems);
  checkRecord(value.elements, "elements", problems, checkElement);
  checkRecord(value.stops, "stops", problems, checkStop);
  checkRecord(value.routes, "routes", problems, checkRoute);
  checkRecord(value.assets, "assets", problems, checkAsset);
  return problems;
}

/** Narrows `value` to a snapshot, or throws with the problems found. */
export function assertSnapshot(value: unknown): asserts value is DocumentSnapshot {
  const problems = validateSnapshot(value);
  if (problems.length > 0) {
    throw new Error(`Invalid document:\n${problems.slice(0, 20).join("\n")}`);
  }
}
