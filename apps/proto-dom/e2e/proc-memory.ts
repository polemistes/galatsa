// SPDX-License-Identifier: GPL-3.0-or-later

// Memory of the browser as the operating system sees it, on Linux: the sum of the
// proportional set size (PSS) of every process below this test worker, which are
// the browser Playwright started and its renderer, GPU and utility processes.
// Unlike the in-page measurements this includes decoded images, layers and GPU
// buffers mapped into those processes. Elsewhere it reports nothing.

import { readdirSync, readFileSync } from "node:fs";

function children(): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // The parent pid is the second field after the parenthesised command name.
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const parent = Number(after[1]);
      const list = map.get(parent) ?? [];
      list.push(Number(name));
      map.set(parent, list);
    } catch {
      // The process ended.
    }
  }
  return map;
}

function pssKiB(pid: number): number {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const match = /^Pss:\s+(\d+) kB/m.exec(rollup);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/** Total PSS in bytes of all descendants of this process, or null if unavailable. */
export function browserPssBytes(): number | null {
  if (process.platform !== "linux") return null;
  const tree = children();
  let total = 0;
  const stack = [...(tree.get(process.pid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    total += pssKiB(pid);
    stack.push(...(tree.get(pid) ?? []));
  }
  return total * 1024;
}

export interface MemorySampler {
  stop(): { peakBytes: number | null; samples: { t: number; bytes: number }[] };
}

/** Samples browserPssBytes() every `everyMs` until stop(). */
export function sampleMemory(everyMs = 500): MemorySampler {
  const samples: { t: number; bytes: number }[] = [];
  const start = Date.now();
  const take = () => {
    const bytes = browserPssBytes();
    if (bytes !== null) samples.push({ t: Date.now() - start, bytes });
  };
  take();
  const timer = setInterval(take, everyMs);
  return {
    stop() {
      clearInterval(timer);
      take();
      const peakBytes =
        samples.length > 0 ? Math.max(...samples.map((s) => s.bytes)) : null;
      return { peakBytes, samples };
    },
  };
}
