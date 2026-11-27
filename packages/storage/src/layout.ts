// SPDX-License-Identifier: GPL-3.0-or-later

// Where the layer keeps what in a backend, and the small JSON records. Section 4
// of docs/adr/0006-storage.md.
//
//   doc/<slot>/info                 the stored document's description (JSON)
//   doc/<slot>/cp/<generation>      checkpoints: the whole document (framed .galatsa)
//   doc/<slot>/j/<session>-<seq>    journal: Yjs updates since the checkpoints (framed)
//   doc/<slot>/a/<asset id>         asset bytes, by content address
//   doc/<slot>/s/<session>          one record per session that has the document open

export const DOC_PREFIX = "doc/";
const GEN_DIGITS = 10;
const SEQ_DIGITS = 8;

export const keys = {
  slot: (slot: string) => `${DOC_PREFIX}${slot}/`,
  info: (slot: string) => `${DOC_PREFIX}${slot}/info`,
  checkpoints: (slot: string) => `${DOC_PREFIX}${slot}/cp/`,
  checkpoint: (slot: string, generation: number) =>
    `${DOC_PREFIX}${slot}/cp/${String(generation).padStart(GEN_DIGITS, "0")}`,
  journal: (slot: string) => `${DOC_PREFIX}${slot}/j/`,
  entry: (slot: string, session: string, seq: number) =>
    `${DOC_PREFIX}${slot}/j/${session}-${String(seq).padStart(SEQ_DIGITS, "0")}`,
  assets: (slot: string) => `${DOC_PREFIX}${slot}/a/`,
  asset: (slot: string, id: string) => `${DOC_PREFIX}${slot}/a/${id}`,
  sessions: (slot: string) => `${DOC_PREFIX}${slot}/s/`,
  session: (slot: string, id: string) => `${DOC_PREFIX}${slot}/s/${id}`,
};

/** The generation of a checkpoint key, or NaN. */
export function generationOf(key: string): number {
  const last = key.slice(key.lastIndexOf("/") + 1);
  return /^\d+$/.test(last) ? Number(last) : Number.NaN;
}

/** What a list of keys under DOC_PREFIX says about each slot. */
export interface SlotKeys {
  slot: string;
  info: boolean;
  checkpoints: number[];
  journal: string[];
  sessions: string[];
  assets: string[];
}

export function groupKeys(all: readonly string[]): Map<string, SlotKeys> {
  const slots = new Map<string, SlotKeys>();
  for (const key of all) {
    if (!key.startsWith(DOC_PREFIX)) continue;
    const parts = key.slice(DOC_PREFIX.length).split("/");
    const slot = parts[0]!;
    let entry = slots.get(slot);
    if (!entry) {
      entry = {
        slot,
        info: false,
        checkpoints: [],
        journal: [],
        sessions: [],
        assets: [],
      };
      slots.set(slot, entry);
    }
    if (parts.length === 2 && parts[1] === "info") entry.info = true;
    else if (parts.length === 3 && parts[1] === "cp") {
      const generation = generationOf(key);
      if (Number.isFinite(generation)) entry.checkpoints.push(generation);
    } else if (parts.length === 3 && parts[1] === "j") entry.journal.push(key);
    else if (parts.length === 3 && parts[1] === "s") entry.sessions.push(parts[2]!);
    else if (parts.length === 3 && parts[1] === "a") entry.assets.push(parts[2]!);
  }
  for (const entry of slots.values()) entry.checkpoints.sort((a, b) => a - b);
  return slots;
}

/** The description of a stored document. */
export interface SlotInfo {
  title: string;
  documentId: string;
  createdAt: number;
  /** When the stored document last changed (approximately: at each checkpoint). */
  changedAt: number;
  /** The name of the file it was opened from or last saved to. */
  fileName: string | null;
  /** When it was last saved to that file. */
  savedToFileAt: number | null;
  /** When it was last handed to the browser as a download (not a save). */
  downloadedAt: number | null;
}

/** A session's record: what a later start needs to know if the session dies. */
export interface SessionRecord {
  startedAt: number;
  /** Last sign of life (only kept up to date where liveness cannot be asked). */
  heartbeatAt: number;
  /** When the session last stored a change (approximately). */
  changedAt: number | null;
  /** The session stored changes that are not in the file (if there is one). */
  unsaved: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function parseObject(bytes: Uint8Array | undefined): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const numOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Reads an info record; a missing or damaged one reads as defaults. */
export function decodeInfo(bytes: Uint8Array | undefined): SlotInfo {
  const raw = parseObject(bytes) ?? {};
  return {
    title: str(raw["title"]),
    documentId: str(raw["documentId"]),
    createdAt: num(raw["createdAt"], 0),
    changedAt: num(raw["changedAt"], 0),
    fileName: typeof raw["fileName"] === "string" ? raw["fileName"] : null,
    savedToFileAt: numOrNull(raw["savedToFileAt"]),
    downloadedAt: numOrNull(raw["downloadedAt"]),
  };
}

/** Reads a session record; null if it is missing or damaged. */
export function decodeSession(bytes: Uint8Array | undefined): SessionRecord | null {
  const raw = parseObject(bytes);
  if (!raw) return null;
  return {
    startedAt: num(raw["startedAt"], 0),
    heartbeatAt: num(raw["heartbeatAt"], 0),
    changedAt: numOrNull(raw["changedAt"]),
    unsaved: raw["unsaved"] === true,
  };
}

/** A random id of 20 characters from [a-z0-9]. */
export function randomId(): string {
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) id += "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36];
  return id;
}
