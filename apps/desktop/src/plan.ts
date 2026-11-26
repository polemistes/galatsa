// SPDX-License-Identifier: GPL-3.0-or-later

// The measurement plan: which engines run, in which order, and how many times.
// Each engine runs in a freshly loaded page (run.html), so that memory left behind
// by one engine does not count against the next. The plan travels from page to
// page in the query string.

/** The three engine prototypes, in the order "run all" uses. */
export const ENGINE_IDS = ["konva", "canvas2d", "dom"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export type RunMode = "capture" | "timing";

/**
 * Runs per engine, in one page: a capture run first, which also warms up the page
 * (fonts, image decoders, code), then two timing runs. Only timing runs count.
 */
export const RUNS_PER_ENGINE: readonly RunMode[] = ["capture", "timing", "timing"];

/** Rough minutes per engine on a typical laptop, for the hint on the start screen. */
export const MINUTES_PER_ENGINE = 5;

export interface RunPlan {
  /** Session folder name (see start_session in the Rust code). */
  readonly session: string;
  readonly engines: readonly EngineId[];
  /** Index into engines of the engine to run on this page. */
  readonly index: number;
}

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === "string" && (ENGINE_IDS as readonly string[]).includes(value);
}

export function planToQuery(plan: RunPlan): string {
  const params = new URLSearchParams({
    session: plan.session,
    engines: plan.engines.join(","),
    index: String(plan.index),
    // The harness's own memory API needs cross-origin isolation, which the app
    // does not set up; skip it instead of waiting for it to fail.
    memory: "0",
  });
  return `?${params.toString()}`;
}

/** The plan in a query string, or null if it is missing or malformed. */
export function planFromQuery(search: string): RunPlan | null {
  const params = new URLSearchParams(search);
  const session = params.get("session");
  const engines = (params.get("engines") ?? "").split(",").filter((e) => e !== "");
  const index = Number(params.get("index"));
  if (session === null || !/^[A-Za-z0-9_.-]+$/.test(session)) return null;
  if (engines.length === 0 || !engines.every(isEngineId)) return null;
  if (!Number.isInteger(index) || index < 0 || index >= engines.length) return null;
  return { session, engines, index };
}

/** The plan for the next page, or null after the last engine. */
export function nextPlan(plan: RunPlan): RunPlan | null {
  return plan.index + 1 < plan.engines.length ? { ...plan, index: plan.index + 1 } : null;
}

/** Local date and time as YYYY-MM-DD_HH-MM-SS, for the session folder name. */
export function sessionStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_` +
    `${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

/** File name of one run's result: <platform>-<engine>-<run>-<mode>.json. */
export function resultFileName(
  platform: string,
  engine: EngineId,
  run: number,
  mode: RunMode,
): string {
  return `${platform}-${engine}-${run}-${mode}.json`;
}

/** File name of a capture image of a run. */
export function captureFileName(
  platform: string,
  engine: EngineId,
  index: number,
  label: string,
): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${platform}-${engine}-capture-${String(index + 1).padStart(2, "0")}-${slug || "hold"}.png`;
}
