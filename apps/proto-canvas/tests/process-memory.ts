// SPDX-License-Identifier: GPL-3.0-or-later

// Samples the memory of every process the test worker has started (the browser and
// its helper processes), from /proc on Linux. This covers what the browser's own
// memory APIs leave out: decoded images, canvas backing stores, GPU process memory
// and the encoded image files the harness keeps. PSS (proportional set size) counts
// shared pages once across the processes. Elsewhere it records nothing.

import { readdirSync, readFileSync } from "node:fs";

export interface MemorySample {
  /** Milliseconds since the sampler started. */
  readonly t: number;
  /** Sum of PSS over the browser's processes, bytes. */
  readonly pssBytes: number;
  readonly processes: number;
}

function parentOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is in parentheses and may contain spaces.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(rest[1]);
  } catch {
    return undefined;
  }
}

function pssOf(pid: number): number {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const match = /^Pss:\s+(\d+) kB/m.exec(rollup);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function descendants(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid)) continue;
    const parent = parentOf(pid);
    if (parent === undefined) continue;
    let list = children.get(parent);
    if (list === undefined) children.set(parent, (list = []));
    list.push(pid);
  }
  const out: number[] = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

export class ProcessMemorySampler {
  readonly samples: MemorySample[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly start = performance.now();
  readonly available = process.platform === "linux";

  sample(): MemorySample | undefined {
    if (!this.available) return undefined;
    const pids = descendants(process.pid);
    const sample = {
      t: Math.round(performance.now() - this.start),
      pssBytes: pids.reduce((sum, pid) => sum + pssOf(pid), 0),
      processes: pids.length,
    };
    this.samples.push(sample);
    return sample;
  }

  begin(intervalMs: number): void {
    if (!this.available) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), intervalMs);
  }

  end(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.sample();
  }

  peak(fromT = 0, toT = Infinity): number {
    return this.samples
      .filter((s) => s.t >= fromT && s.t <= toT)
      .reduce((max, s) => Math.max(max, s.pssBytes), 0);
  }
}
