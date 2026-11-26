// SPDX-License-Identifier: GPL-3.0-or-later

// Memory measurement, where the browser offers it. Nothing is estimated: when a
// browser has no way to measure, the result says so.
//
// - performance.measureUserAgentSpecificMemory(): standard draft, Chromium only so
//   far, and only on cross-origin isolated pages (COOP and COEP headers). It may wait
//   for the next garbage collection, which can take many seconds, so it is only
//   called outside the timed frames.
// - performance.memory: non-standard, Chromium only. The JavaScript heap only; images
//   decoded by the browser and GPU memory are not included. Chromium rounds the
//   values unless started with --enable-precise-memory-info.
// - An external sampler: a function the host gives the runner (for example a desktop
//   shell that reads the memory of its own processes). It is polled during load and
//   the run, and called at the run's events (see BenchEvent in runner.ts). It is the
//   only source that can include decoded images and GPU memory, and the only one
//   used for the memory verdict.

export interface JsHeapSample {
  /** Frame index: -1 before load, 0 to frames - 1 during the run, frames after it. */
  readonly frame: number;
  readonly usedBytes: number;
  readonly totalBytes: number;
}

export interface MemoryReport {
  /** measureUserAgentSpecificMemory() results in bytes, or null where not measured. */
  readonly userAgentSpecific: {
    readonly available: boolean;
    /** Why it was not available or failed, if so. */
    readonly note: string | null;
    readonly beforeLoadBytes: number | null;
    readonly afterLoadBytes: number | null;
    readonly afterRunBytes: number | null;
  };
  /** performance.memory samples, or available: false. */
  readonly jsHeap: {
    readonly available: boolean;
    /** Highest used size from the start of the run (frame 0) to its end. */
    readonly peakUsedBytes: number | null;
    readonly samples: readonly JsHeapSample[];
  };
  /** Results of the external sampler, if one was given. */
  readonly external: {
    readonly available: boolean;
    /** What the sampler measures, as it describes itself. */
    readonly source: string | null;
    readonly peakBytes: number | null;
    readonly samples: readonly ExternalMemorySample[];
    /** Polls that had not answered when the run ended (after a 5 s wait). */
    readonly unanswered: number;
  };
}

export interface ExternalMemorySample {
  /** The event at which it was taken ("run-start", "hold-start", ...) or "poll". */
  readonly event: string;
  /** Frame index of the run, or null outside the frames. */
  readonly frame: number | null;
  readonly bytes: number;
}

/** A memory sampler outside the page, for example in a desktop shell. */
export interface ExternalMemorySampler {
  /** What it measures, for example "resident memory of the app and its web processes". */
  readonly source: string;
  /**
   * Bytes in use now, or null if it cannot tell. Called every `intervalMs` from
   * the start of load() to the end of the run, and at the run's events, without
   * waiting for the answer; it must not block the page.
   */
  sample(): Promise<number | null>;
  /** Milliseconds between polls. Default 250. */
  readonly intervalMs?: number;
}

/** Waiting for the external sampler's outstanding answers stops after this long. */
export const EXTERNAL_SETTLE_TIMEOUT_MS = 5000;

/**
 * The memory peak to judge an engine by: only the host's sampler, which can see the
 * whole program (decoded images, GPU memory, other processes). The browser's own
 * figures cover the JavaScript heap and little else (in one run 9.7 MB against
 * 1,610 MiB of process memory), so they are never used for the verdict.
 */
export function externalPeakMemory(
  report: MemoryReport,
): { bytes: number; source: string } | null {
  if (report.external.peakBytes === null) return null;
  return {
    bytes: report.external.peakBytes,
    source: report.external.source ?? "host sampler",
  };
}

interface ChromiumMemoryInfo {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
}

interface MeasureMemoryResult {
  readonly bytes: number;
}

type MeasureMemory = () => Promise<MeasureMemoryResult>;

/** performance.memory, if this browser has it. */
export function readJsHeap(): ChromiumMemoryInfo | undefined {
  const memory = (performance as unknown as { memory?: ChromiumMemoryInfo }).memory;
  return memory !== undefined && typeof memory.usedJSHeapSize === "number"
    ? memory
    : undefined;
}

function measureFunction(): MeasureMemory | undefined {
  const fn = (
    performance as unknown as { measureUserAgentSpecificMemory?: MeasureMemory }
  ).measureUserAgentSpecificMemory;
  return typeof fn === "function" ? fn.bind(performance) : undefined;
}

/** Why measureUserAgentSpecificMemory cannot be used here, or null if it can. */
export function userAgentMemoryUnavailableReason(): string | null {
  if (measureFunction() === undefined) {
    return "performance.measureUserAgentSpecificMemory is not supported by this browser";
  }
  if (!globalThis.crossOriginIsolated) {
    return "the page is not cross-origin isolated (needs COOP and COEP headers)";
  }
  return null;
}

/**
 * Calls measureUserAgentSpecificMemory with a time limit. Resolves to the byte count,
 * or to an error message.
 */
export async function measureUserAgentMemory(
  timeoutMs: number,
): Promise<{ bytes: number } | { error: string }> {
  const fn = measureFunction();
  if (fn === undefined || userAgentMemoryUnavailableReason() !== null) {
    return { error: userAgentMemoryUnavailableReason() ?? "unavailable" };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ error: `no answer within ${timeoutMs} ms` }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([fn().then((r) => ({ bytes: r.bytes })), timeout]);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Collects memory figures over one run. */
export class MemoryRecorder {
  private readonly samples: JsHeapSample[] = [];
  private readonly heapAvailable = readJsHeap() !== undefined;
  private readonly uaNote = userAgentMemoryUnavailableReason();
  private readonly ua: Record<"beforeLoad" | "afterLoad" | "afterRun", number | null> = {
    beforeLoad: null,
    afterLoad: null,
    afterRun: null,
  };
  private uaError: string | null = null;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly sampler: ExternalMemorySampler | undefined;
  private readonly externalSamples: ExternalMemorySample[] = [];
  private readonly pendingExternal: Promise<void>[] = [];
  private readonly isSettled: (() => boolean)[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private unanswered = 0;

  /**
   * @param enabled whether to call measureUserAgentSpecificMemory at all
   * @param timeoutMs how long to wait for each measureUserAgentSpecificMemory call
   * @param sampler optional external sampler
   */
  constructor(enabled: boolean, timeoutMs: number, sampler?: ExternalMemorySampler) {
    this.enabled = enabled;
    this.timeoutMs = timeoutMs;
    this.sampler = sampler;
  }

  /**
   * Asks the external sampler for a sample, without waiting for it. Call
   * settleExternal() before report() to collect the answers.
   */
  sampleExternal(event: string, frame: number | null): void {
    if (this.sampler === undefined) return;
    let settled = false;
    const done = this.sampler.sample().then(
      (bytes) => {
        if (bytes !== null) this.externalSamples.push({ event, frame, bytes });
      },
      () => {},
    );
    this.pendingExternal.push(
      done.finally(() => {
        settled = true;
      }),
    );
    this.isSettled.push(() => settled);
  }

  /** Polls the external sampler every intervalMs until stopPolling(). */
  startPolling(currentFrame: () => number | null): void {
    if (this.sampler === undefined || this.timer !== undefined) return;
    this.timer = setInterval(
      () => this.sampleExternal("poll", currentFrame()),
      this.sampler.intervalMs ?? 250,
    );
  }

  stopPolling(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Waits for the external sampler's outstanding answers. */
  async settleExternal(timeoutMs = EXTERNAL_SETTLE_TIMEOUT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(this.pendingExternal),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    this.unanswered = this.isSettled.filter((settled) => !settled()).length;
  }

  /** Records a JavaScript heap sample, if available. Cheap enough to call during the run. */
  sampleHeap(frame: number): void {
    const heap = readJsHeap();
    if (heap === undefined) return;
    this.samples.push({
      frame,
      usedBytes: heap.usedJSHeapSize,
      totalBytes: heap.totalJSHeapSize,
    });
  }

  /** Records a measureUserAgentSpecificMemory result. Slow; never during the run. */
  async measure(point: "beforeLoad" | "afterLoad" | "afterRun"): Promise<void> {
    if (!this.enabled || this.uaNote !== null || this.uaError !== null) return;
    const result = await measureUserAgentMemory(this.timeoutMs);
    if ("bytes" in result) this.ua[point] = result.bytes;
    else this.uaError = result.error;
  }

  report(): MemoryReport {
    const used = this.samples.filter((s) => s.frame >= 0).map((s) => s.usedBytes);
    return {
      userAgentSpecific: {
        available: this.enabled && this.uaNote === null && this.uaError === null,
        note: this.enabled ? (this.uaNote ?? this.uaError) : "turned off for this run",
        beforeLoadBytes: this.ua.beforeLoad,
        afterLoadBytes: this.ua.afterLoad,
        afterRunBytes: this.ua.afterRun,
      },
      jsHeap: {
        available: this.heapAvailable,
        peakUsedBytes: used.length > 0 ? Math.max(...used) : null,
        samples: this.samples,
      },
      external: {
        available: this.sampler !== undefined,
        source: this.sampler?.source ?? null,
        peakBytes:
          this.externalSamples.length > 0
            ? Math.max(...this.externalSamples.map((s) => s.bytes))
            : null,
        samples: this.externalSamples,
        unanswered: this.unanswered,
      },
    };
  }
}
