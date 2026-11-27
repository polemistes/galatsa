// SPDX-License-Identifier: GPL-3.0-or-later

// Import and export: turning other file formats into document content, and
// documents into other formats. See docs/adr/0005-extension-interface.md,
// section 6.

import type {
  AssetId,
  AssetInfo,
  DocumentSnapshot,
  ElementId,
  Fragment,
  Rect,
  RouteId,
} from "@galatsa/core";
import type { MessageValues } from "@galatsa/i18n";
import type { IconRef, Label } from "./ids.ts";

/** A kind of file, for file pickers, drag and drop and "save as". */
export interface FileType {
  readonly label: Label;
  /** IANA media types, for example "image/png". */
  readonly mediaTypes: readonly string[];
  /** File name extensions, lower case, without the dot. */
  readonly extensions: readonly string[];
}

/**
 * Lets the user stop a long import or export. Hosts adapt their own signal (an
 * AbortSignal in browsers and Node) to this.
 */
export interface Cancellation {
  readonly cancelled: boolean;
  /** Calls `listener` once when cancelled. Returns a function that removes it. */
  onCancel(listener: () => void): () => void;
}

/** Thrown by importers and exporters that stop because they were cancelled. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

/** Throws CancelledError if the work was cancelled. Call it between steps. */
export function throwIfCancelled(cancellation: Cancellation): void {
  if (cancellation.cancelled) throw new CancelledError();
}

/**
 * Something for the user to know about a finished import or export: what was
 * left out, approximated or could not be read.
 */
export interface Notice {
  readonly message: Label;
  readonly values?: MessageValues;
}

/** Shared by imports and exports. */
export interface TransferContext {
  readonly cancellation: Cancellation;
  /**
   * Reports progress: a fraction from 0 to 1, or undefined when the amount of
   * work is unknown. Cheap enough to call often.
   */
  progress(fraction: number | undefined): void;
}

/**
 * Where asset bytes live while the program runs (the open file's assets, the
 * app's cache). The host provides it.
 */
export interface AssetStore {
  /**
   * Stores bytes and returns their asset id (the SHA-256 of the bytes) and a
   * description. Storing the same bytes twice gives the same id.
   */
  put(
    bytes: Uint8Array,
    facts: Omit<AssetInfo, "byteLength" | "external">,
  ): Promise<{ readonly id: AssetId; readonly info: AssetInfo }>;
  get(id: AssetId): Promise<Uint8Array | undefined>;
}

/** A file to import. An importer reads it whole or as a stream, whichever suits it. */
export interface ImportSource {
  readonly name: string;
  /** As the platform reports it; may be missing or wrong, so importers may sniff. */
  readonly mediaType: string | undefined;
  /** In bytes, if known. */
  readonly size: number | undefined;
  bytes(): Promise<Uint8Array>;
  chunks(): AsyncIterable<Uint8Array>;
}

export interface ImportContext extends TransferContext {
  /** Where to put the bytes of images, video and fonts found in the file. */
  readonly assets: AssetStore;
}

/**
 * What an import produced: content to paste, never writes to a document. The
 * editor pastes the fragment with one command (one undo step), where the user
 * dropped the file or in the middle of the view. The asset bytes are in the
 * store already; the fragment holds their descriptions.
 */
export interface ImportResult {
  readonly fragment: Fragment;
  readonly notices: readonly Notice[];
}

export interface ImporterDefinition {
  /** Importer name; the importer id is "<extension id>/<name>". */
  readonly name: string;
  readonly label: Label;
  readonly icon?: IconRef;
  readonly fileTypes: readonly FileType[];
  /** Offered in quick mode too. Every importer is offered in advanced mode. */
  readonly quick?: boolean;
  /**
   * Recognises the file from its first bytes (at most 4096), when the name and
   * media type do not decide.
   */
  sniff?(head: Uint8Array): boolean;
  /** Reads the file. Rejects with CancelledError when cancelled. */
  read(source: ImportSource, context: ImportContext): Promise<ImportResult>;
}

/**
 * What an exporter gets. The document is always purged for sharing (removed
 * content, revisions and delete marks gone; docs/adr/0001, section 5.8), and
 * the asset reader serves only assets the purged document refers to, so
 * nothing deleted can leave the program through an export. Exporters never see
 * the live document.
 */
export interface ExportInput {
  readonly snapshot: DocumentSnapshot;
  /** The route to export, for formats that are a sequence (slides, video). */
  readonly route: RouteId | null;
  /** Elements to export, for "export selection"; null for everything. */
  readonly selection: readonly ElementId[] | null;
  readonly assets: { get(id: AssetId): Promise<Uint8Array | undefined> };
}

/** Where an exporter writes: once for a whole file, many times for a stream. */
export interface ExportOutput {
  write(chunk: Uint8Array): Promise<void>;
}

/**
 * Draws a region of the document into an encoded image, through the renderer
 * and the element types, for exports made of pictures (PDF, a series of
 * images). The region is a rectangle in the space of a container (null for the
 * root), like a stop's view.
 */
export type RegionRenderer = (
  region: { readonly space: ElementId | null; readonly rect: Rect },
  image: {
    readonly width: number;
    readonly height: number;
    readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
  },
) => Promise<Uint8Array>;

export interface ExportContext extends TransferContext {
  /** Present where a renderer is available (not in a headless build). */
  readonly render?: RegionRenderer;
}

export interface ExporterDefinition {
  /** Exporter name; the exporter id is "<extension id>/<name>". */
  readonly name: string;
  readonly label: Label;
  readonly icon?: IconRef;
  readonly fileType: FileType;
  /** Offered in quick mode too. Every exporter is offered in advanced mode. */
  readonly quick?: boolean;
  /** Writes the export. Rejects with CancelledError when cancelled. */
  write(
    input: ExportInput,
    output: ExportOutput,
    context: ExportContext,
  ): Promise<{
    readonly notices: readonly Notice[];
  }>;
}
