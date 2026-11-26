// SPDX-License-Identifier: GPL-3.0-or-later

// Structural validation of a document snapshot read from outside (a file, the
// network). It checks shapes and types, not references: dangling parents, stops
// and assets are legal and handled by resolution (section 5). Section 9.6 of
// docs/adr/0001-document-model-and-file-format.md.

import { FRAME_TYPE, GROUP_TYPE, type DocumentSnapshot } from "./types.ts";

export const ASSET_ID_PATTERN = /^sha256-[0-9a-f]{64}$/;
export const ELEMENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
/** Ids are opaque, 1 to 64 characters from the URL-safe base64 alphabet. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type Problems = string[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function checkJson(value: unknown, path: string, problems: Problems, depth = 0): void {
  if (depth > 256) {
    problems.push(`${path}: nested too deeply`);
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) problems.push(`${path}: number is not finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkJson(item, `${path}[${i}]`, problems, depth + 1));
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      checkJson(item, `${path}.${key}`, problems, depth + 1);
    }
    return;
  }
  problems.push(`${path}: not a JSON value`);
}

function checkDelta(value: unknown, path: string, problems: Problems): void {
  if (!Array.isArray(value)) {
    problems.push(`${path}: delta must be an array`);
    return;
  }
  value.forEach((run, i) => {
    const at = `${path}[${i}]`;
    if (!isObject(run)) return void problems.push(`${at}: run must be an object`);
    if (typeof run.insert !== "string" && !isObject(run.insert)) {
      problems.push(`${at}.insert: must be a string or an object`);
    } else if (isObject(run.insert)) {
      checkJson(run.insert, `${at}.insert`, problems);
    }
    if (run.attributes !== undefined) {
      if (!isObject(run.attributes)) problems.push(`${at}.attributes: must be an object`);
      else checkJson(run.attributes, `${at}.attributes`, problems);
    }
  });
}

function checkXmlNode(
  value: unknown,
  path: string,
  problems: Problems,
  depth: number,
): void {
  if (!isObject(value)) return void problems.push(`${path}: XML node must be an object`);
  if (value.$y === "xmlText") return checkDelta(value.delta, `${path}.delta`, problems);
  if (value.$y !== "xmlElement") return void problems.push(`${path}: unknown XML node`);
  if (typeof value.name !== "string" || value.name === "") {
    problems.push(`${path}.name: must be a non-empty string`);
  }
  if (!isObject(value.attributes)) problems.push(`${path}.attributes: must be an object`);
  else checkJson(value.attributes, `${path}.attributes`, problems);
  checkXmlChildren(value.children, `${path}.children`, problems, depth + 1);
}

function checkXmlChildren(
  value: unknown,
  path: string,
  problems: Problems,
  depth: number,
): void {
  if (!Array.isArray(value)) return void problems.push(`${path}: must be an array`);
  value.forEach((child, i) => checkXmlNode(child, `${path}[${i}]`, problems, depth));
}

/**
 * Checks a value inside element data. Only a value placed directly in a data map,
 * a shared map or a shared array can be a tagged shared type; anything nested in
 * plain JSON is plain JSON, "$y" keys included.
 */
export function checkDataValue(
  value: unknown,
  path: string,
  problems: Problems,
  depth = 0,
): void {
  if (depth > 256) return void problems.push(`${path}: nested too deeply`);
  if (!isObject(value) || !("$y" in value))
    return checkJson(value, path, problems, depth);
  switch (value.$y) {
    case "json":
      return checkJson(value.value, `${path}.value`, problems, depth + 1);
    case "text":
      return checkDelta(value.delta, `${path}.delta`, problems);
    case "map":
      if (!isObject(value.entries))
        return void problems.push(`${path}.entries: must be an object`);
      for (const [key, item] of Object.entries(value.entries)) {
        checkDataValue(item, `${path}.entries.${key}`, problems, depth + 1);
      }
      return;
    case "array":
      if (!Array.isArray(value.items))
        return void problems.push(`${path}.items: must be an array`);
      value.items.forEach((item, i) =>
        checkDataValue(item, `${path}.items[${i}]`, problems, depth + 1),
      );
      return;
    case "xmlFragment":
      return checkXmlChildren(value.children, `${path}.children`, problems, depth + 1);
    case "xmlElement":
    case "xmlText":
      return checkXmlNode(value, path, problems, depth + 1);
    default:
      problems.push(`${path}.$y: unknown shared type ${JSON.stringify(value.$y)}`);
  }
}

function checkPosition(value: unknown, path: string, problems: Problems): void {
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  if (!isFiniteNumber(value.x)) problems.push(`${path}.x: must be a finite number`);
  if (!isFiniteNumber(value.y)) problems.push(`${path}.y: must be a finite number`);
  if (value.space !== null && typeof value.space !== "string") {
    problems.push(`${path}.space: must be an id or null`);
  }
}

function checkSize(value: unknown, path: string, problems: Problems): void {
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  for (const key of ["w", "h"] as const) {
    const v = value[key];
    if (!isFiniteNumber(v) || v < 0)
      problems.push(`${path}.${key}: must be a finite number >= 0`);
  }
}

function checkElement(id: string, value: unknown, problems: Problems): void {
  const path = `elements.${id}`;
  if (!ID_PATTERN.test(id)) problems.push(`${path}: invalid id`);
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  if (typeof value.type !== "string" || !ELEMENT_TYPE_PATTERN.test(value.type)) {
    problems.push(`${path}.type: invalid element type id`);
  }
  if (!Number.isInteger(value.typeVersion) || (value.typeVersion as number) < 1) {
    problems.push(`${path}.typeVersion: must be an integer >= 1`);
  }
  if (value.parent !== null && typeof value.parent !== "string") {
    problems.push(`${path}.parent: must be an id or null`);
  }
  if (typeof value.order !== "string") problems.push(`${path}.order: must be a string`);
  checkPosition(value.pos, `${path}.pos`, problems);
  if (typeof value.name !== "string") problems.push(`${path}.name: must be a string`);
  if (typeof value.locked !== "boolean")
    problems.push(`${path}.locked: must be a boolean`);
  if (
    !Array.isArray(value.assets) ||
    !value.assets.every((a) => typeof a === "string" && ASSET_ID_PATTERN.test(a))
  ) {
    problems.push(`${path}.assets: must be an array of asset ids`);
  }
  if (
    value.removed !== null &&
    value.removed !== "delete" &&
    value.removed !== "dissolve"
  ) {
    problems.push(`${path}.removed: must be null, "delete" or "dissolve"`);
  }
  const container = value.type === FRAME_TYPE || value.type === GROUP_TYPE;
  if (value.removed === "dissolve" && !container) {
    problems.push(`${path}.removed: only frames and groups can be dissolved`);
  }
  if (value.type !== GROUP_TYPE) checkSize(value.size, `${path}.size`, problems);
  if (!container && !isFiniteNumber(value.rot))
    problems.push(`${path}.rot: must be a finite number`);
  if (!isObject(value.data)) return void problems.push(`${path}.data: must be an object`);
  for (const [key, item] of Object.entries(value.data)) {
    checkDataValue(item, `${path}.data.${key}`, problems);
  }
}

function checkStop(id: string, value: unknown, problems: Problems): void {
  const path = `stops.${id}`;
  if (!ID_PATTERN.test(id)) problems.push(`${path}: invalid id`);
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  if (typeof value.name !== "string") problems.push(`${path}.name: must be a string`);
  const view = value.view;
  if (!isObject(view)) problems.push(`${path}.view: must be an object`);
  else if (view.kind === "frame") {
    if (typeof view.frame !== "string")
      problems.push(`${path}.view.frame: must be an id`);
    if (!isFiniteNumber(view.padding) || view.padding < 0) {
      problems.push(`${path}.view.padding: must be a finite number >= 0`);
    }
  } else if (view.kind === "rect") {
    if (view.space !== null && typeof view.space !== "string") {
      problems.push(`${path}.view.space: must be an id or null`);
    }
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
  } else checkDelta(value.notes.delta, `${path}.notes.delta`, problems);
  if (!isObject(value.visibility)) problems.push(`${path}.visibility: must be an object`);
  else {
    for (const [element, change] of Object.entries(value.visibility)) {
      if (!isObject(change) || (change.action !== "show" && change.action !== "hide")) {
        problems.push(`${path}.visibility.${element}: action must be "show" or "hide"`);
      }
    }
  }
  checkJson(value.transition, `${path}.transition`, problems);
  if (typeof value.removed !== "boolean")
    problems.push(`${path}.removed: must be a boolean`);
}

function checkRoute(id: string, value: unknown, problems: Problems): void {
  const path = `routes.${id}`;
  if (!ID_PATTERN.test(id)) problems.push(`${path}: invalid id`);
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  if (typeof value.name !== "string") problems.push(`${path}.name: must be a string`);
  if (typeof value.order !== "string") problems.push(`${path}.order: must be a string`);
  if (typeof value.removed !== "boolean")
    problems.push(`${path}.removed: must be a boolean`);
  if (!isObject(value.entries))
    return void problems.push(`${path}.entries: must be an object`);
  for (const [entryId, entry] of Object.entries(value.entries)) {
    const at = `${path}.entries.${entryId}`;
    if (!ID_PATTERN.test(entryId)) problems.push(`${at}: invalid id`);
    if (
      !isObject(entry) ||
      typeof entry.stop !== "string" ||
      typeof entry.order !== "string"
    ) {
      problems.push(`${at}: must have string "stop" and "order"`);
    }
  }
}

function checkAsset(id: string, value: unknown, problems: Problems): void {
  const path = `assets.${id}`;
  if (!ASSET_ID_PATTERN.test(id)) problems.push(`${path}: invalid asset id`);
  if (!isObject(value)) return void problems.push(`${path}: must be an object`);
  if (typeof value.mediaType !== "string" || !value.mediaType.includes("/")) {
    problems.push(`${path}.mediaType: must be a media type`);
  }
  if (!Number.isInteger(value.byteLength) || (value.byteLength as number) < 0) {
    problems.push(`${path}.byteLength: must be an integer >= 0`);
  }
  if (value.name !== undefined && typeof value.name !== "string")
    problems.push(`${path}.name: must be a string`);
  for (const key of ["width", "height"] as const) {
    if (value[key] !== undefined && !isFiniteNumber(value[key])) {
      problems.push(`${path}.${key}: must be a finite number`);
    }
  }
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
  const problems: Problems = [];
  if (!isObject(value)) return ["document: must be an object"];
  if (!Number.isInteger(value.schemaVersion))
    problems.push("schemaVersion: must be an integer");
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id))
    problems.push("id: invalid id");
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
