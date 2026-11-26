// SPDX-License-Identifier: GPL-3.0-or-later

// The bench's external memory sampler, backed by the host. The bench only keeps
// the totals; this keeps what is needed to trust them: how many samples had no
// total and why, and which processes made up the highest one.

import type { ExternalMemorySampler } from "@galatsa/bench";
import type { MemorySample, ProcessMemory } from "./host.ts";

export const SAMPLE_INTERVAL_MS = 250;

export interface HostMemoryReport {
  readonly source: string;
  readonly intervalMs: number;
  readonly samples: number;
  /** Samples whose total was null (a web view process missing or unreadable). */
  readonly withoutTotal: number;
  /** Calls that failed (the command threw). */
  readonly failed: number;
  /** Each distinct problem the host reported, with how often. */
  readonly problems: Readonly<Record<string, number>>;
  /** The sample with the highest total, process by process. */
  readonly peak: {
    readonly bytes: number;
    readonly processes: readonly ProcessMemory[];
  } | null;
  /** Highest number of processes seen in one sample. */
  readonly maxProcesses: number;
}

export class MemoryRecorder {
  readonly sampler: ExternalMemorySampler;
  private samples = 0;
  private withoutTotal = 0;
  private failed = 0;
  private problems: Record<string, number> = {};
  private peak: HostMemoryReport["peak"] = null;
  private maxProcesses = 0;
  private readonly source: string;

  constructor(source: string, sample: () => Promise<MemorySample>) {
    this.source = source;
    this.sampler = {
      source,
      intervalMs: SAMPLE_INTERVAL_MS,
      sample: async () => {
        try {
          const s = await sample();
          this.record(s);
          return s.bytes;
        } catch (error) {
          this.failed++;
          const message = error instanceof Error ? error.message : String(error);
          this.problems[message] = (this.problems[message] ?? 0) + 1;
          return null;
        }
      },
    };
  }

  /** Forget everything; called before each run. */
  reset(): void {
    this.samples = 0;
    this.withoutTotal = 0;
    this.failed = 0;
    this.problems = {};
    this.peak = null;
    this.maxProcesses = 0;
  }

  record(s: MemorySample): void {
    this.samples++;
    this.maxProcesses = Math.max(this.maxProcesses, s.processes.length);
    if (s.problem !== null)
      this.problems[s.problem] = (this.problems[s.problem] ?? 0) + 1;
    if (s.bytes === null) {
      this.withoutTotal++;
    } else if (this.peak === null || s.bytes > this.peak.bytes) {
      this.peak = { bytes: s.bytes, processes: s.processes };
    }
  }

  report(): HostMemoryReport {
    return {
      source: this.source,
      intervalMs: SAMPLE_INTERVAL_MS,
      samples: this.samples,
      withoutTotal: this.withoutTotal,
      failed: this.failed,
      problems: { ...this.problems },
      peak: this.peak,
      maxProcesses: this.maxProcesses,
    };
  }
}
