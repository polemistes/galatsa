// SPDX-License-Identifier: GPL-3.0-or-later

// What the storage layer needs from its surroundings, behind small interfaces so
// tests can control it: timers, telling live programs from dead ones, and a
// channel between tabs. Section 5 of docs/adr/0006-storage.md.

/** Timers and the clock. */
export interface Scheduler {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The platform's timers, looked up at each call (so test fakes apply). */
export const systemScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/**
 * Tells sessions that are running (in this tab, another tab or another window)
 * from sessions whose program stopped without closing them.
 */
export interface Liveness {
  /** Marks the session as running until the returned function is called. */
  hold(sessionId: string): () => void;
  /** The sessions among `ids` that are running, or null if this cannot tell. */
  alive(ids: readonly string[]): Promise<ReadonlySet<string> | null>;
}

interface LockManagerLike {
  request(name: string, callback: () => Promise<void>): Promise<void>;
  query(): Promise<{ held?: { name?: string }[] }>;
}

function lockManager(): LockManagerLike | null {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator
    ?.locks;
  return locks && typeof locks.request === "function" && typeof locks.query === "function"
    ? locks
    : null;
}

/**
 * Liveness through the Web Locks API: each running session holds a lock, which
 * the browser releases when the tab closes or crashes. Null where the API is
 * missing (then the layer falls back to heartbeats).
 */
export function webLocksLiveness(prefix = "galatsa-storage-session:"): Liveness | null {
  const locks = lockManager();
  if (!locks) return null;
  return {
    hold(sessionId) {
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      locks.request(prefix + sessionId, () => held).catch(() => {});
      return () => release();
    },
    async alive(ids) {
      try {
        const state = await locks.query();
        const names = new Set((state.held ?? []).map((lock) => lock.name));
        return new Set(ids.filter((id) => names.has(prefix + id)));
      } catch {
        return null;
      }
    },
  };
}

/** Liveness within one program, for tests: `kill` ends a session as a crash would. */
export interface MemoryLiveness extends Liveness {
  kill(sessionId: string): void;
}

export function memoryLiveness(): MemoryLiveness {
  const running = new Set<string>();
  return {
    hold(sessionId) {
      running.add(sessionId);
      return () => running.delete(sessionId);
    },
    async alive(ids) {
      return new Set(ids.filter((id) => running.has(id)));
    },
    kill(sessionId) {
      running.delete(sessionId);
    },
  };
}

/** A journal entry one session tells the others about. */
export interface ChannelMessage {
  session: string;
  key: string;
  update: Uint8Array;
}

/** A channel between the sessions of one document in different tabs. */
export interface Channel {
  post(message: ChannelMessage): void;
  listen(listener: (message: ChannelMessage) => void): void;
  close(): void;
}

export type ChannelFactory = (name: string) => Channel;

/** BroadcastChannel, where the platform has it. */
export function broadcastChannels(): ChannelFactory | null {
  const Broadcast = (globalThis as { BroadcastChannel?: typeof BroadcastChannel })
    .BroadcastChannel;
  if (typeof Broadcast !== "function") return null;
  return (name) => {
    const channel = new Broadcast(name);
    return {
      post(message) {
        try {
          channel.postMessage(message);
        } catch {
          // A closed channel or a message it cannot clone: the others will find
          // the entry in the journal at their next checkpoint.
        }
      },
      listen(listener) {
        channel.onmessage = (event: MessageEvent) => {
          const data = event.data as Partial<ChannelMessage> | null;
          if (
            data &&
            typeof data.session === "string" &&
            typeof data.key === "string" &&
            data.update instanceof Uint8Array
          ) {
            listener(data as ChannelMessage);
          }
        };
      },
      close() {
        channel.close();
      },
    };
  };
}

/** Channels within one program, for tests. Messages are delivered asynchronously. */
export function memoryChannels(): ChannelFactory {
  const listeners = new Map<string, Set<(message: ChannelMessage) => void>>();
  return (name) => {
    const own = new Set<(message: ChannelMessage) => void>();
    let open = true;
    return {
      post(message) {
        if (!open) return;
        for (const listener of listeners.get(name) ?? []) {
          if (own.has(listener)) continue;
          queueMicrotask(() => listener({ ...message, update: message.update.slice() }));
        }
      },
      listen(listener) {
        own.add(listener);
        let set = listeners.get(name);
        if (!set) listeners.set(name, (set = new Set()));
        set.add(listener);
      },
      close() {
        open = false;
        for (const listener of own) listeners.get(name)?.delete(listener);
      },
    };
  };
}
