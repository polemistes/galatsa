// SPDX-License-Identifier: GPL-3.0-or-later

// Building checkpoints in a worker, so that the editing thread only encodes the
// Yjs state (a few tens of milliseconds for a large document) and never waits
// for the file to be written (most of a second). Section 4.2 of
// docs/adr/0006-storage.md.

import { FileFormatError } from "@galatsa/format";
import { encodeCheckpointFile, type CheckpointEncoder } from "./checkpoint.ts";

/** The part of a Worker (or a MessagePort) the encoder needs. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(
    type: "error" | "messageerror",
    listener: (event: Event) => void,
  ): void;
  terminate?(): void;
}

interface Request {
  id: number;
  state: Uint8Array;
  generator: string;
}

type Reply =
  | { id: number; file: Uint8Array; keepState: boolean }
  | { id: number; error: { code: string | null; detail: string } };

export interface WorkerEncoderOptions {
  generator?: string;
  /**
   * How long to wait for the worker's answer (default 60 seconds). A worker
   * that does not answer in time is given up for good, and the work is done on
   * this thread.
   */
  timeoutMs?: number;
}

/**
 * A checkpoint encoder that sends the work to a worker running
 * `serveCheckpoints` (the module "@galatsa/storage/checkpoint-worker"). If the
 * worker fails to start, dies, sends something that cannot be read, or does not
 * answer in time, it is given up and the work is done on this thread, so a
 * checkpoint is never lost to a worker problem.
 */
export function workerEncoder(
  worker: WorkerLike,
  options: WorkerEncoderOptions = {},
): CheckpointEncoder {
  const generator = options.generator ?? "Galatsa";
  const timeoutMs = options.timeoutMs ?? 60_000;
  let next = 0;
  let broken = false;
  const waiting = new Map<number, (value: Reply | null) => void>();
  const giveUp = () => {
    broken = true;
    for (const [id, resolve] of waiting) {
      waiting.delete(id);
      resolve(null);
    }
    try {
      worker.terminate?.();
    } catch {
      // Already gone.
    }
  };
  worker.addEventListener("message", (event: MessageEvent) => {
    const reply = event.data as Reply | null;
    if (!reply || typeof reply.id !== "number") return;
    const resolve = waiting.get(reply.id);
    if (!resolve) return;
    waiting.delete(reply.id);
    resolve(reply);
  });
  worker.addEventListener("error", giveUp);
  worker.addEventListener("messageerror", giveUp);
  return async (state) => {
    if (broken) return encodeCheckpointFile(state, generator);
    const id = ++next;
    const reply = await new Promise<Reply | null>((resolve) => {
      const timer = setTimeout(giveUp, timeoutMs);
      waiting.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      const request: Request = { id, state, generator };
      try {
        worker.postMessage(request);
      } catch {
        giveUp();
      }
    });
    if (reply && "file" in reply && reply.file instanceof Uint8Array) {
      return { file: reply.file, keepState: reply.keepState === true };
    }
    if (reply && "error" in reply) {
      const { code, detail } = reply.error;
      if (code === "newer-version" || code === "too-large") {
        throw new FileFormatError(code, detail);
      }
    }
    // Anything else (the worker itself failed): do it here.
    return encodeCheckpointFile(state, generator);
  };
}

/** The worker side: answers checkpoint requests on `scope` (the worker's global). */
export function serveCheckpoints(scope: {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}): void {
  scope.addEventListener("message", (event: MessageEvent) => {
    const request = event.data as Partial<Request> | null;
    if (
      !request ||
      typeof request.id !== "number" ||
      !(request.state instanceof Uint8Array)
    ) {
      return;
    }
    let reply: Reply;
    const transfer: Transferable[] = [];
    try {
      const encoded = encodeCheckpointFile(request.state, request.generator ?? "Galatsa");
      reply = { id: request.id, file: encoded.file, keepState: encoded.keepState };
      transfer.push(encoded.file.buffer as ArrayBuffer);
    } catch (error) {
      reply = {
        id: request.id,
        error: {
          code: error instanceof FileFormatError ? error.code : null,
          detail: String((error as { message?: unknown } | null)?.message ?? error),
        },
      };
    }
    scope.postMessage(reply, transfer);
  });
}
