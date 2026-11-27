// SPDX-License-Identifier: GPL-3.0-or-later

// The user's own files: where a presentation is opened from and saved to.
// Section 6 of docs/adr/0006-storage.md.

import { FILE_EXTENSION, MIMETYPE } from "@galatsa/format";
import { StorageError } from "./backend.ts";

/** A file the user chose to open. */
export interface FileSource {
  /** The file name, for messages and to find the copy the layer kept of it. */
  readonly name: string;
  read(): Promise<Uint8Array>;
}

/** A file the user chose to save to (and usually to open from). */
export interface FileTarget extends FileSource {
  /**
   * Replaces the file's content, atomically: if the write fails or the program
   * stops in the middle, the file keeps its old content. (File System Access API:
   * the browser writes to a temporary file and swaps it in on close. A desktop
   * file system: a temporary file next to it, flushed, then renamed over it.)
   */
  write(bytes: Uint8Array): Promise<void>;
  /** False for a target that cannot read back what it wrote, such as a download. */
  readonly canRead: boolean;
}

/** The parts of the File System Access API used here. */
interface PermissionHandle {
  queryPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor: {
    mode: "read" | "readwrite";
  }): Promise<PermissionState>;
}

async function ensurePermission(
  handle: FileSystemFileHandle,
  mode: "read" | "readwrite",
) {
  const h = handle as FileSystemFileHandle & PermissionHandle;
  if (!h.queryPermission) return;
  if ((await h.queryPermission({ mode })) === "granted") return;
  if (h.requestPermission && (await h.requestPermission({ mode })) === "granted") return;
  throw new StorageError("unavailable", "Permission to the file was not granted");
}

/** A file on disk through the File System Access API (or the origin private file system). */
export function fileHandleTarget(handle: FileSystemFileHandle): FileTarget {
  return {
    name: handle.name,
    canRead: true,
    async read() {
      await ensurePermission(handle, "read");
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async write(bytes) {
      await ensurePermission(handle, "readwrite");
      const writable = await handle.createWritable({ keepExistingData: false });
      try {
        await writable.write(bytes as Uint8Array<ArrayBuffer>);
        await writable.close();
      } catch (error) {
        // Nothing reaches the file until close() succeeds; abort drops the
        // temporary copy.
        await writable.abort().catch(() => {});
        throw error;
      }
    },
  };
}

/** A file the user picked with an upload control (`<input type="file">`). */
export function uploadedFile(file: Blob & { name: string }): FileSource {
  return {
    name: file.name,
    async read() {
      return new Uint8Array(await file.arrayBuffer());
    },
  };
}

/**
 * Saving by download, where the File System Access API is missing: every save
 * is a new file in the downloads folder, so nothing is ever overwritten. It
 * cannot read back what it wrote.
 */
export function downloadTarget(name: string): FileTarget {
  return {
    name,
    canRead: false,
    async read() {
      throw new StorageError("unavailable", "A download cannot be read back");
    },
    async write(bytes) {
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIMETYPE });
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        link.rel = "noopener";
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        // Give the browser time to start the download before the URL goes.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    },
  };
}

interface PickerWindow {
  showOpenFilePicker?(options?: unknown): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: unknown): Promise<FileSystemFileHandle>;
}

function pickerTypes(description: string) {
  return [{ description, accept: { [MIMETYPE]: [FILE_EXTENSION] } }];
}

/** True where the browser can open and save files in place (File System Access API). */
export function canSaveInPlace(): boolean {
  return typeof (globalThis as PickerWindow).showSaveFilePicker === "function";
}

/**
 * Lets the user pick a presentation to open. Uses the File System Access API
 * where there is one (the result can then be saved in place), otherwise an
 * upload control. Must be called from a user action (a click). Resolves to null
 * if the user cancels. `typeLabel` is the translated name of the file type.
 */
export async function pickFileToOpen(
  typeLabel: string,
): Promise<FileSource | FileTarget | null> {
  const w = globalThis as PickerWindow;
  if (typeof w.showOpenFilePicker === "function") {
    try {
      const [handle] = await w.showOpenFilePicker({ types: pickerTypes(typeLabel) });
      return handle ? fileHandleTarget(handle) : null;
    } catch (error) {
      if ((error as { name?: unknown }).name === "AbortError") return null;
      throw error;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${FILE_EXTENSION},${MIMETYPE}`;
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      resolve(file ? uploadedFile(file) : null);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/**
 * Lets the user choose where to save. Uses the File System Access API where
 * there is one, otherwise saves by download. Must be called from a user action.
 * Resolves to null if the user cancels.
 */
export async function pickFileToSave(
  suggestedName: string,
  typeLabel: string,
): Promise<FileTarget | null> {
  const w = globalThis as PickerWindow;
  if (typeof w.showSaveFilePicker === "function") {
    try {
      return fileHandleTarget(
        await w.showSaveFilePicker({ suggestedName, types: pickerTypes(typeLabel) }),
      );
    } catch (error) {
      if ((error as { name?: unknown }).name === "AbortError") return null;
      throw error;
    }
  }
  return downloadTarget(suggestedName);
}

/** A file in memory, for tests. It can simulate a save torn in the middle. */
export interface MemoryFile extends FileTarget {
  bytes: Uint8Array | null;
  /**
   * The next write stores only the first `atByte` bytes and then fails: a file
   * system without atomic replacement that stopped in the middle of a save.
   */
  tearNextWrite(atByte: number): void;
  /** The next write fails and changes nothing. */
  failNextWrite(): void;
}

export function memoryFile(name: string, bytes: Uint8Array | null = null): MemoryFile {
  let tearAt: number | null = null;
  let fail = false;
  const file: MemoryFile = {
    name,
    bytes,
    canRead: true,
    async read() {
      if (!file.bytes) throw new StorageError("failed", "The file does not exist");
      return file.bytes.slice();
    },
    async write(data) {
      await Promise.resolve();
      if (fail) {
        fail = false;
        throw new StorageError("failed", "Simulated write failure");
      }
      if (tearAt !== null) {
        file.bytes = data.slice(0, Math.max(0, Math.min(tearAt, data.length)));
        tearAt = null;
        throw new StorageError("failed", "Simulated torn write");
      }
      file.bytes = data.slice();
    },
    tearNextWrite(atByte) {
      tearAt = atByte;
    },
    failNextWrite() {
      fail = true;
    },
  };
  return file;
}
