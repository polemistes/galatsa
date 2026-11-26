// SPDX-License-Identifier: GPL-3.0-or-later

// Tests the runner's bookkeeping in Node, with a fake animation-frame clock that
// ticks exactly 16 ms per frame. Real frame timing is tested in a browser (tests/e2e).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraPose, CameraRun } from "./camera.ts";
import type { BenchEngine, EngineSetup } from "./engine.ts";
import { createNoopEngine } from "./engines/noop.ts";
import { runBenchmark } from "./runner.ts";
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

function fakeContainer(): HTMLElement {
  return { style: {}, replaceChildren: () => {} } as unknown as HTMLElement;
}

describe("runBenchmark", () => {
  beforeEach(() => {
    let now = 1000;
    vi.stubGlobal("requestAnimationFrame", (callback: (t: number) => void) =>
      setTimeout(() => callback((now += 16)), 0),
    );
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
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
    const result = await runBenchmark({
      engine,
      container: fakeContainer(),
      images,
      scene,
      cameraRun: shortRun,
      warmupFrames: 5,
      measureMemory: false,
    });
    expect(loaded).toBe(true);
    expect(disposed).toBe(true);
    expect(rendered).toHaveLength(5 + 12);
    expect(rendered.slice(0, 5)).toEqual(Array(5).fill(pose(0)));
    expect(rendered.slice(5)).toEqual(shortRun.poses);
    expect(result.frames.intervalMs).toEqual(Array(12).fill(16));
    expect(result.timings.runMs).toBe(12 * 16);
    expect(result.stats.interval.p95).toBe(16);
    expect(result.stats.intervalByKind.hold?.count).toBe(5);
    expect(result.stats.intervalByKind.pan?.count).toBe(7);
    expect(result.environment.warmupIntervalMs).toBe(16);
    expect(result.environment.hiddenDuringRun).toBe(false);
    expect(result.engine).toBe("recorder");
    expect(result.scene.elements).toBe(2000);
    expect(result.memory.userAgentSpecific.available).toBe(false);
    expect(result.memory.jsHeap.available).toBe(false);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("records the text-sharp latency of each hold, or null if never reported", async () => {
    const noop = await runBenchmark({
      engine: createNoopEngine(),
      container: fakeContainer(),
      images,
      scene,
      cameraRun: shortRun,
      warmupFrames: 2,
      measureMemory: false,
    });
    expect(noop.textSharp.events.map((e) => e.label)).toEqual([
      "first hold",
      "second hold",
    ]);
    expect(noop.textSharp.events.map((e) => e.frame)).toEqual([4, 10]);
    expect(noop.textSharp.reported).toBe(2);
    for (const event of noop.textSharp.events) {
      expect(event.latencyMs).toBeGreaterThanOrEqual(0);
      expect(event.latencyMs).toBeLessThan(50);
    }

    // Reports only in the second frame of a hold: the first hold gets a latency,
    // and so does the second; an engine that never reports gets nulls.
    let setup: EngineSetup | undefined;
    let frame = 0;
    const late: BenchEngine = {
      name: "late",
      load: (s) => {
        setup = s;
        return Promise.resolve();
      },
      render: () => {
        frame++;
        if (frame === 2 + 6) setup!.reportTextSharp(); // warm-up 2, then frame index 5
      },
      dispose: () => {},
    };
    const lateResult = await runBenchmark({
      engine: late,
      container: fakeContainer(),
      images,
      scene,
      cameraRun: shortRun,
      warmupFrames: 2,
      measureMemory: false,
    });
    expect(lateResult.textSharp.events[0]!.latencyMs).not.toBeNull();
    expect(lateResult.textSharp.events[1]!.latencyMs).toBeNull();
    expect(lateResult.textSharp.reported).toBe(1);
    expect(lateResult.textSharp.missing).toBe(1);
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
    await expect(
      runBenchmark({
        engine: broken,
        container: fakeContainer(),
        images,
        scene,
        cameraRun: shortRun,
        measureMemory: false,
      }),
    ).rejects.toThrow("boom");
    expect(disposed).toBe(true);
  });
});
