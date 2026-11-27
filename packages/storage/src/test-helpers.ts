// SPDX-License-Identifier: GPL-3.0-or-later

// Helpers for the storage layer's own tests: a clock that tests move by hand,
// and "machines" (one store, outliving programs) with "programs" that can crash.

import { addElement, moveElement } from "@galatsa/core/ydoc";
import type * as Y from "yjs";
import {
  memoryLiveness,
  type ChannelFactory,
  type MemoryLiveness,
  type Scheduler,
} from "./environment.ts";
import { createMemoryStore, type MemoryBackend, type MemoryStore } from "./memory.ts";
import type { AutosaveTiming, StorageSession } from "./session.ts";
import { DocumentStorage } from "./storage.ts";

/**
 * Lets pending promises, microtasks and finished I/O run, through `rounds` turns
 * of the event loop.
 *
 * Each turn is a message through a MessageChannel, not a setTimeout(0). A
 * zero-delay timer waits for the system timer: about 1 ms on Linux and macOS, but
 * up to about 15.6 ms on Windows, where the storage tests then spent nearly all
 * their time in here and ran past Vitest's time limit. A message is a task of its
 * own, so the microtask queue is drained and finished I/O is handled before it
 * arrives, but it does not wait for the clock. (setImmediate would do the same,
 * but this package is typed for browsers, without Node's types.) The storage code
 * under test takes its timers from the ManualScheduler, so no real timer has to
 * fire.
 */
export async function settle(rounds = 30): Promise<void> {
  const channel = new MessageChannel();
  try {
    for (let i = 0; i < rounds; i++) {
      await new Promise<void>((resolve) => {
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      });
    }
  } finally {
    channel.port1.close();
  }
}

export class ManualScheduler implements Scheduler {
  time = 1_800_000_000_000;
  #timers: { at: number; callback: () => void; id: number }[] = [];
  #next = 1;

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.push({ at: this.time + Math.max(0, ms), callback, id });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }

  /** Moves the clock, firing timers in order and letting their work run. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      await settle();
      const due = this.#timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.time = Math.max(this.time, due.at);
      due.callback();
    }
    this.time = end;
    await settle();
  }
}

export interface Machine {
  store: MemoryStore;
  liveness: MemoryLiveness;
  channels: ChannelFactory | null;
}

export function machine(channels: ChannelFactory | null = null): Machine {
  return { store: createMemoryStore(), liveness: memoryLiveness(), channels };
}

export interface Program {
  backend: MemoryBackend;
  scheduler: ManualScheduler;
  storage: DocumentStorage;
  /** Stops the program without closing anything: its writes stop, its sessions die. */
  crash(...sessions: StorageSession[]): void;
}

export function program(
  m: Machine,
  timing: Partial<AutosaveTiming> = {},
  options: { heartbeats?: boolean } = {},
): Program {
  const backend = m.store.backend();
  const scheduler = new ManualScheduler();
  const storage = new DocumentStorage({
    backend,
    liveness: options.heartbeats ? null : m.liveness,
    channels: m.channels,
    scheduler,
    timing,
    lifecycle: false,
  });
  return {
    backend,
    scheduler,
    storage,
    crash(...sessions) {
      backend.kill();
      for (const session of sessions) m.liveness.kill(session.id);
    },
  };
}

let counter = 0;

/** Adds a box and returns its id. */
export function addBox(doc: Y.Doc, x = 0, y = 0): string {
  counter++;
  return addElement(doc, {
    type: "test.shapes/box",
    x,
    y,
    size: { w: 10 + (counter % 7), h: 10 },
    name: `box ${counter}`,
  });
}

export function nudge(doc: Y.Doc, id: string, dx: number): void {
  moveElement(doc, id, dx, dx / 2);
}
