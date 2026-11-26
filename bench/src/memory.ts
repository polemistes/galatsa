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

export interface JsHeapSample {
  /** Frame index of the run (-1 for before load, after the run: the frame count). */
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
    readonly peakUsedBytes: number | null;
    readonly samples: readonly JsHeapSample[];
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

  /**
   * @param enabled whether to call measureUserAgentSpecificMemory at all
   * @param timeoutMs how long to wait for each measureUserAgentSpecificMemory call
   */
  constructor(enabled: boolean, timeoutMs: number) {
    this.enabled = enabled;
    this.timeoutMs = timeoutMs;
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
    const used = this.samples.map((s) => s.usedBytes);
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
    };
  }
}
