// SPDX-License-Identifier: GPL-3.0-or-later

// Memory of the browser the test started, as the operating system sees it: the
// sum of PSS (proportional set size, shared pages counted once) over every
// process below the test worker, read from /proc. Linux only; elsewhere null.

import { readdirSync, readFileSync } from "node:fs";

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

/** Bytes of PSS of the processes this test process started, or null off Linux. */
export function browserMemory(): number | null {
  if (process.platform !== "linux") return null;
  return descendants(process.pid).reduce((sum, pid) => sum + pssOf(pid), 0);
}
