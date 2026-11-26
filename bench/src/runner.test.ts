// SPDX-License-Identifier: GPL-3.0-or-later

// Tests the runner's bookkeeping in Node, with a fake animation-frame clock whose
// timestamps advance exactly 16 ms per frame. Real frame timing is tested in
// browsers (tests/e2e).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraPose, CameraRun } from "./camera.ts";
import type { BenchEngine, EngineSetup } from "./engine.ts";
import { createNoopEngine } from "./engines/noop.ts";
import { syntheticBusyMs } from "./engines/synthetic.ts";
import { type BenchEvent, type RunOptions, runBenchmark } from "./runner.ts";
import { generateScene } from "./scene.ts";

const scene = generateScene();
const pose = (x: number): CameraPose => ({ x, y: 0, zoom: 1 });

// 4 moving frames, 3 still frames, 3 moving frames, 2 still frames.
const shortRun: CameraRun = {
  poses: [0, 1, 2, 3, 3, 3, 3, 4, 5, 6, 6, 6].map(pose),
  segments: [
    { kind: "pan", label: "a", start: 0, end: 4 },
    { kind: "hold", label: "first hold", start: 4, end: 7 },
    { kind: "pan", label: "b", start: 7, end: 10 },
    { kind: "hold", label: "second hold", start: 10, end: 12 },
  ],
  stops: [],
};

const images = {
  encodedBytes: 0,
  generationMs: 0,
  getBlob(): Blob {
    throw new Error("not used");
  },
};

let windowSize = { width: 2000, height: 2000 };

function fakeContainer(width = 1280, height = 720): HTMLElement {
  return {
    style: {},
    replaceChildren: () => {},
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
    }),
  } as unknown as HTMLElement;
}

function options(engine: BenchEngine, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    engine,
    container: fakeContainer(),
    images,
    scene,
    cameraRun: shortRun,
    warmupFrames: 2,
    calibrationFrames: 10,
    settle: { minMs: 0, maxMs: 0 },
    measureMemory: false,
    ...extra,
  };
}

describe("runBenchmark", () => {
  beforeEach(() => {
    let now = 1000;
    windowSize = { width: 2000, height: 2000 };
    vi.stubGlobal("requestAnimationFrame", (callback: (t: number) => void) =>
      setTimeout(() => callback((now += 16)), 0),
    );
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
      documentElement: {
        get clientWidth() {
          return windowSize.width;
        },
        get clientHeight() {
          return windowSize.height;
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders every pose once after the warm-up, and times every frame", async () => {
    const rendered: CameraPose[] = [];
    let loaded = false;
    let disposed = false;
    const engine: BenchEngine = {
      name: "recorder",
      load: () => {
        loaded = true;
        return Promise.resolve();
      },
      render: (camera) => rendered.push(camera),
      dispose: () => {
        disposed = true;
      },
    };
    const result = await runBenchmark(options(engine, { warmupFrames: 5 }));
    expect(loaded).toBe(true);
    expect(disposed).toBe(true);
    expect(rendered).toHaveLength(5 + 12);
    expect(rendered.slice(0, 5)).toEqual(Array(5).fill(pose(0)));
    expect(rendered.slice(5)).toEqual(shortRun.poses);
    expect(result.frames.timestampMs).toEqual(Array(12).fill(16));
    expect(result.frames.frameMs).toHaveLength(12);
    expect(result.frames.renderMs).toHaveLength(12);
    expect(result.frames.excluded).toEqual([]);
    expect(result.environment.refresh.intervalMs).toBe(16);
    expect(result.verdictInputs.refreshIntervalMs).toBe(16);
    expect(result.verdictInputs.frames).toBe(12);
    expect(result.verdictInputs.missedFrames.thresholdMs).toBe(24);
    expect(result.stats.frameMsByKind.hold?.count).toBe(5);
    expect(result.stats.frameMsByKind.pan?.count).toBe(7);
    expect(result.environment.stage.fullyVisible).toBe(true);
    expect(result.verdictInputs.valid).toBe(true);
    expect(result.scene.elements).toBe(2000);
    expect(result.memory.userAgentSpecific.available).toBe(false);
    expect(result.memory.external.available).toBe(false);
    expect(result.captures).toEqual([]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("stops the text-sharp clock at the next animation frame after the report", async () => {
    const noop = await runBenchmark(options(createNoopEngine()));
    expect(noop.textSharp.events.map((e) => e.label)).toEqual([
      "first hold",
      "second hold",
    ]);
    expect(noop.textSharp.events.map((e) => e.frame)).toEqual([4, 10]);
    expect(noop.textSharp.reported).toBe(2);
    for (const event of noop.textSharp.events) {
      expect(event.reportMs).not.toBeNull();
      expect(event.latencyMs!).toBeGreaterThanOrEqual(event.reportMs!);
    }

    // Reports only in the second frame of the first hold; never in the second.
    let setup: EngineSetup | undefined;
    let calls = 0;
    const late: BenchEngine = {
      name: "late",
      load: (s) => {
        setup = s;
        return Promise.resolve();
      },
      render: () => {
        calls++;
        if (calls === 2 + 6) setup!.reportTextSharp(); // warm-up 2, then frame index 5
      },
      dispose: () => {},
    };
    const lateResult = await runBenchmark(options(late));
    expect(lateResult.textSharp.events[0]!.latencyMs).not.toBeNull();
    expect(lateResult.textSharp.events[1]!.latencyMs).toBeNull();
    expect(lateResult.textSharp.missing).toBe(1);
  });

  it("emits phase and hold events in order, and samples external memory at them", async () => {
    const events: BenchEvent[] = [];
    let bytes = 100;
    const result = await runBenchmark(
      options(createNoopEngine(), {
        onEvent: (e) => events.push(e),
        memorySampler: { source: "test", sample: () => Promise.resolve((bytes += 10)) },
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "settle-start",
      "settle-end",
      "calibrate-start",
      "calibrate-end",
      "load-start",
      "load-end",
      "run-start",
      "hold-start",
      "hold-end",
      "hold-start",
      "hold-end",
      "run-end",
    ]);
    expect(events.filter((e) => e.type === "hold-start").map((e) => e.frame)).toEqual([
      4, 10,
    ]);
    expect(result.memory.external.samples.map((s) => s.event)).toEqual([
      "load-start",
      "load-end",
      "run-start",
      "hold-start",
      "hold-start",
      "run-end",
    ]);
    expect(result.verdictInputs.peakMemory).toEqual({
      bytes: 160,
      source: "external: test",
    });
  });

  it("pauses for captures at the end of each hold and leaves those frames out", async () => {
    const captured: number[] = [];
    const result = await runBenchmark(
      options(createNoopEngine(), {
        capture: (hold) => {
          captured.push(hold.frame);
          return Promise.resolve({
            label: hold.label,
            frame: hold.frame,
            by: "host",
            dataUrl: "data:,",
          });
        },
      }),
    );
    expect(captured).toEqual([6, 11]);
    expect(result.captures.map((c) => c.frame)).toEqual([6, 11]);
    expect(result.frames.excluded).toEqual([6, 11]);
    expect(result.verdictInputs.frames).toBe(10);
  });

  it("refuses to run when the stage is not fully inside the window", async () => {
    windowSize = { width: 1000, height: 600 };
    let loaded = false;
    const engine: BenchEngine = {
      ...createNoopEngine(),
      load: () => {
        loaded = true;
        return Promise.resolve();
      },
    };
    await expect(runBenchmark(options(engine))).rejects.toThrow(
      /does not fit in the window/,
    );
    expect(loaded).toBe(false);
    const allowed = await runBenchmark(
      options(createNoopEngine(), { requireVisibleStage: false }),
    );
    expect(allowed.environment.stage.fullyVisible).toBe(false);
    expect(allowed.verdictInputs.valid).toBe(false);
  });

  it("disposes the engine and rejects when render() throws", async () => {
    let disposed = false;
    const broken: BenchEngine = {
      name: "broken",
      load: () => Promise.resolve(),
      render: () => {
        throw new Error("boom");
      },
      dispose: () => {
        disposed = true;
      },
    };
    await expect(runBenchmark(options(broken))).rejects.toThrow("boom");
    expect(disposed).toBe(true);
  });
});

describe("syntheticBusyMs", () => {
  it("is the same for the same frame, between 5 and 25 ms", () => {
    for (let i = 0; i < 1000; i++) {
      const ms = syntheticBusyMs(i);
      expect(ms).toBe(syntheticBusyMs(i));
      expect(ms).toBeGreaterThanOrEqual(5);
      expect(ms).toBeLessThan(25);
    }
    expect(syntheticBusyMs(1)).not.toBe(syntheticBusyMs(2));
  });
});
