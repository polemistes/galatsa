// SPDX-License-Identifier: GPL-3.0-or-later

// Importing files into the open document (docs/adr/0005 section 6.1, and
// docs/adr/0012-images-and-assets.md): files that are dropped on the canvas,
// pasted from the system clipboard, or picked. Each file goes to the importer
// whose file types take its media type or name extension, or, when none does,
// to the first whose `sniff` recognises its first bytes. Importers return
// fragments; all of one import are pasted with one command, so dropping ten
// images is one undo step. The asset store the importers put bytes into also
// makes the reduced versions of images (assets.ts).

import type { Fragment, Point } from "@galatsa/core";
import type {
  EditorHost,
  ImporterDefinition,
  ImportResult,
  ImportSource,
  Mode,
  Notice,
  Registered,
} from "@galatsa/extension-api/editing";
import { fragmentBounds } from "./clipboard.ts";

/** A file to import, as the browser gives it (a `File` is one). */
export interface ImportFile {
  readonly name: string;
  /** Media type as the platform reports it; may be empty. */
  readonly type: string;
  readonly size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** How many bytes `sniff` gets. */
export const SNIFF_BYTES = 4096;
/** The most files one import takes; more are left out with a notice. */
export const MAX_IMPORT_FILES = 100;
/** Files after the first are placed this many screen pixels down and right of the one before. */
export const IMPORT_CASCADE = 24;

/** An import source over a file, read once. */
export function importSource(file: ImportFile): ImportSource & {
  head(): Promise<Uint8Array>;
} {
  let bytes: Promise<Uint8Array> | null = null;
  const all = (): Promise<Uint8Array> =>
    (bytes ??= file.arrayBuffer().then((b) => new Uint8Array(b)));
  return {
    name: file.name,
    mediaType: file.type === "" ? undefined : file.type,
    size: file.size,
    bytes: all,
    async *chunks() {
      yield await all();
    },
    head: async () => (await all()).subarray(0, SNIFF_BYTES),
  };
}

/**
 * The importer for a file: the first whose file types take its media type or
 * name extension, else the first whose `sniff` recognises its first bytes.
 */
export async function chooseImporter(
  host: EditorHost,
  source: {
    readonly name: string;
    readonly mediaType?: string | undefined;
    head(): Promise<Uint8Array>;
  },
  mode: Mode,
): Promise<Registered<ImporterDefinition> | null> {
  const byType = host.importersFor(
    { name: source.name, mediaType: source.mediaType },
    mode,
  );
  if (byType.length > 0) return byType[0]!;
  const head = await source.head();
  for (const importer of host.importers(mode)) {
    try {
      if (importer.definition.sniff?.(head)) return importer;
    } catch {
      // A sniff that throws does not recognise the file.
    }
  }
  return null;
}

/** A fragment and where its roots go: moved by (dx, dy). */
export interface PlacedFragment {
  readonly fragment: Fragment;
  readonly dx: number;
  readonly dy: number;
}

/**
 * Where the fragments of one import go: each centred on `at` (root space),
 * the second and later ones moved down and right by `step` world units each.
 */
export function placeFragments(
  fragments: readonly Fragment[],
  at: Point,
  step: number,
): PlacedFragment[] {
  return fragments.map((fragment, i) => {
    const b = fragmentBounds(fragment);
    const cx = b === null ? 0 : b.x + b.w / 2;
    const cy = b === null ? 0 : b.y + b.h / 2;
    return { fragment, dx: at.x - cx + i * step, dy: at.y - cy + i * step };
  });
}

/**
 * One fragment of several placed ones, so they paste as one undo step: their
 * roots moved by their offsets, in order. Only for fragments without stops,
 * routes or fallback views (whose rectangles would need moving too); null if
 * any has them.
 */
export function mergeFragments(placed: readonly PlacedFragment[]): Fragment | null {
  const out: Fragment = {
    elements: {},
    roots: [],
    stops: {},
    routes: {},
    fallbackViews: {},
    assets: {},
  };
  for (const { fragment, dx, dy } of placed) {
    if (
      Object.keys(fragment.stops).length > 0 ||
      Object.keys(fragment.routes).length > 0 ||
      Object.keys(fragment.fallbackViews).length > 0
    )
      return null;
    for (const [id, element] of Object.entries(fragment.elements)) {
      if (Object.hasOwn(out.elements, id)) return null;
      out.elements[id] = element;
    }
    for (const root of fragment.roots) {
      const element = out.elements[root];
      if (element === undefined) continue;
      out.elements[root] = {
        ...element,
        pos: { ...element.pos, x: element.pos.x + dx, y: element.pos.y + dy },
      };
      out.roots.push(root);
    }
    Object.assign(out.assets, fragment.assets);
  }
  return out;
}

/** What one import did. */
export interface ImportReport {
  /** Fragments with something in them, in the order the files came. */
  readonly results: ImportResult[];
  /** Notices of the importers, and for files no importer takes. */
  readonly notices: Notice[];
}

/** Notice keys of the editor's own (namespace "editor"). */
export const IMPORT_NOTICES = {
  unsupported: "editor:import.unsupported",
  failed: "editor:import.failed",
  tooMany: "editor:import.tooMany",
} as const;

/** Runs the importers over files, one after another. Never throws. */
export async function readFiles(
  host: EditorHost,
  files: readonly ImportFile[],
  mode: Mode,
  context: Parameters<ImporterDefinition["read"]>[1],
): Promise<ImportReport> {
  const results: ImportResult[] = [];
  const notices: Notice[] = [];
  if (files.length > MAX_IMPORT_FILES)
    notices.push({
      message: IMPORT_NOTICES.tooMany,
      values: { count: MAX_IMPORT_FILES },
    });
  for (const file of files.slice(0, MAX_IMPORT_FILES)) {
    const source = importSource(file);
    try {
      const importer = await chooseImporter(host, source, mode);
      if (importer === null) {
        notices.push({
          message: IMPORT_NOTICES.unsupported,
          values: { name: file.name },
        });
        continue;
      }
      const result = await importer.definition.read(source, context);
      notices.push(...result.notices);
      if (result.fragment.roots.length > 0) results.push(result);
    } catch (error) {
      if (context.cancellation.cancelled) break;
      console.error(error);
      notices.push({ message: IMPORT_NOTICES.failed, values: { name: file.name } });
    }
  }
  return { results, notices };
}
