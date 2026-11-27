// SPDX-License-Identifier: GPL-3.0-or-later

// The camera of a presentation: at rest, on its way to a stop along a
// transition, or coming to rest while the presenter moves it. Every transition
// is planned in the space of the lowest common ancestor of its two views and
// played under the comfort guard, and one that is stopped before its end is
// continued with breakOff, so that no input makes the picture or its speed
// jump (docs/adr/0005, section 7). Knows nothing of routes: the presentation
// (presentation.ts) says where to go.
//
// Time is a number of milliseconds the caller gives with every call, so the
// camera is a function of what was asked and when, and is tested without a
// browser.

import type { CameraView, ElementId, Point } from "@galatsa/core";
import {
  guardComfort,
  type AnyTransition,
  type CameraMotion,
  type ComfortSettings,
  type MotionFrame,
} from "@galatsa/extension-api";
import { breakOff } from "@galatsa/extension-transitions";
import { sameView, type Screen } from "./model.ts";
import {
  limitFactor,
  NO_NUDGE,
  nudgeView,
  panNudge,
  zoomNudge,
  type Nudge,
} from "./roam.ts";
import {
  MIN_STEER_MS,
  NO_SHIFT,
  shiftAt,
  shiftBetween,
  shiftView,
  steer,
  type Shift,
  type Steer,
} from "./steer.ts";

/** The elements a stop's show and hide changes keep out of the picture (docs/adr/0001, section 6.4). */
export type Hidden = ReadonlySet<ElementId>;

/** A view of the canvas with what is hidden in it. */
export interface Shot {
  readonly view: CameraView;
  readonly hidden: Hidden;
}

/** What the screen shows at one moment: one shot, or a cross-fade of two. */
export type Picture =
  | ({ readonly kind: "view" } & Shot)
  | {
      readonly kind: "blend";
      readonly from: Shot;
      readonly to: Shot;
      /** The opacity of `to` over `from`, strictly between 0 and 1. */
      readonly mix: number;
    };

/** Where to go, and how. */
export interface Leg {
  /** The goal, with the view in the space it is anchored in. */
  readonly goal: Shot;
  readonly transition: AnyTransition;
  /** The stop's options, as read by the transition's `read`. */
  readonly options: unknown;
}

/** What the camera needs of the document. */
export interface Spaces {
  /** Offset between two spaces through their lowest common ancestor (`Resolver.offset`). */
  offset(from: ElementId | null, to: ElementId | null): Point;
  parentOf(id: ElementId): ElementId | null;
  /** A view at rest, anchored and within the zoom limits (roam.ts). */
  place(view: CameraView): CameraView;
  /** A view at rest zoomed about a point on screen (roam.ts). */
  zoomAbout(view: CameraView, ax: number, ay: number, factor: number): CameraView;
}

export interface PlaybackOptions {
  readonly view: CameraView;
  readonly hidden: Hidden;
  readonly comfort: ComfortSettings;
  readonly screen: Screen;
  readonly spaces: Spaces;
}

/**
 * How the goal of a running motion moved. "resize": the screen changed size,
 * and the stop is fitted to it again. "document": the document changed.
 */
export type GoalChange = "resize" | "document";

/**
 * A goal that moved by the document more than this (the distance on screen
 * in screen widths plus the zoom as a natural logarithm) is a new goal: the
 * motion is broken off and the next planned. A smaller move is steered onto.
 */
export const STEER_LIMIT = 0.5;

/** A motion being played. */
interface Run {
  /** As it is played: guarded, and from its own time 0. */
  readonly motion: CameraMotion;
  /** How long the motion itself is. */
  readonly motionDuration: number;
  /** How long it is played: longer when a change of course needed more time. */
  duration: number;
  /** When it started. */
  readonly start: number;
  /** The space its views are in. */
  readonly space: ElementId | null;
  /** Where it is heading; null when it only comes to rest, for the presenter. */
  leg: Leg | null;
  /** The motion's own goal in `space`, before any change of course. */
  readonly to: CameraView | null;
  /**
   * The corrections laid over the motion because its goal moved (steer.ts),
   * and how far from the goal they reach: a view of the motion is corrected
   * in proportion to how much closer to `to` it is than the view on screen
   * was when the first correction began (`reach`, measured with a screen
   * `reachWidth` wide). So the views the motion started from, or came to
   * rest at, stay where they are, the goal gets the whole correction, and a
   * view gets the same correction in a flight and in a cross-fade.
   */
  steer: Steer | null;
  reach: number;
  reachWidth: number;
  /**
   * Views of this motion with what is hidden in them: where it started and
   * the goals it has had. The first that matches a view counts, so a view
   * that has been on screen keeps what it showed.
   */
  marks: readonly Shot[];
  /** What the presenter moved since the motion was left to come to rest. */
  nudge: Nudge;
}

function durationOf(motion: CameraMotion): number {
  return Number.isFinite(motion.duration) ? Math.max(0, motion.duration) : 0;
}

function still(view: CameraView): CameraMotion {
  return { duration: 0, frame: () => ({ kind: "view", view }) };
}

/** The view that fills the screen, or most of it. */
function dominant(frame: MotionFrame): CameraView {
  if (frame.kind === "view") return frame.view;
  return frame.mix < 0.5 ? frame.from : frame.to;
}

/**
 * How far apart two views of the same space are on screen: the distance
 * between their centres in screen widths, plus the zoom between them as a
 * natural logarithm.
 */
function gapOf(a: CameraView, b: CameraView, width: number): number {
  const pan =
    (Math.hypot(b.cx - a.cx, b.cy - a.cy) * Math.min(a.zoom, b.zoom)) /
    Math.max(1, width);
  const zoom = Math.abs(Math.log(b.zoom / a.zoom));
  return Number.isFinite(pan + zoom) ? pan + zoom : Infinity;
}

/** Two sets with the same members. */
export function sameMembers(a: Hidden, b: Hidden): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function nudgeFrame(frame: MotionFrame, n: Nudge): MotionFrame {
  if (frame.kind === "view") return { kind: "view", view: nudgeView(frame.view, n) };
  return {
    kind: "blend",
    from: nudgeView(frame.from, n),
    to: nudgeView(frame.to, n),
    mix: frame.mix,
  };
}

export class Playback {
  readonly #spaces: Spaces;
  #comfort: ComfortSettings;
  #screen: Screen;
  /** The view at rest (while a motion runs: where it started). */
  #view: CameraView;
  /** What is hidden in the view on screen (in a cross-fade: in a view no mark knows). */
  #hidden: Hidden;
  #run: Run | null = null;

  constructor(options: PlaybackOptions) {
    this.#spaces = options.spaces;
    this.#comfort = options.comfort;
    this.#screen = options.screen;
    this.#view = options.view;
    this.#hidden = options.hidden;
  }

  /** True while a motion is running at `now`. */
  moving(now: number): boolean {
    this.#advance(now);
    return this.#run !== null;
  }

  /** The view at rest, or null while a motion is running. */
  resting(now: number): CameraView | null {
    this.#advance(now);
    return this.#run === null ? this.#view : null;
  }

  /** The goal of the motion that is running, if it has one. */
  heading(now: number): Shot | null {
    this.#advance(now);
    return this.#run?.leg?.goal ?? null;
  }

  get screen(): Screen {
    return this.#screen;
  }

  /** The size of the screen for the transitions planned from now on. */
  setScreen(screen: Screen): void {
    this.#screen = screen;
  }

  /** Shows `shot` at once: a cut. */
  rest(shot: Shot): void {
    this.#run = null;
    this.#view = shot.view;
    this.#hidden = shot.hidden;
  }

  /** Changes what is hidden in the view on screen, at once (the camera stays). */
  setHidden(hidden: Hidden, now: number): void {
    this.#advance(now);
    this.#hidden = hidden;
    if (this.#run !== null) this.#run.marks = [];
  }

  /** What the screen shows at `now`. */
  picture(now: number): Picture {
    this.#advance(now);
    const run = this.#run;
    if (run === null) return { kind: "view", view: this.#view, hidden: this.#hidden };
    const frame = this.#frame(run, now - run.start);
    const mark = (view: CameraView): Shot | undefined =>
      run.marks.find((m) => sameView(m.view, view));
    if (frame.kind === "view" || !(frame.mix > 0) || frame.mix >= 1) {
      const view = dominant(frame);
      // A view that fills the screen decides what is hidden from here on: on
      // arrival, and where a cross-fade that was broken off came to rest.
      const known = mark(view);
      if (known !== undefined) this.#hidden = known.hidden;
      return { kind: "view", view: this.#show(run, view, now), hidden: this.#hidden };
    }
    const side = (view: CameraView): Shot => ({
      view: this.#show(run, view, now),
      hidden: mark(view)?.hidden ?? this.#hidden,
    });
    return { kind: "blend", from: side(frame.from), to: side(frame.to), mix: frame.mix };
  }

  /** The view that fills the screen at `now`, or most of it. */
  current(now: number): CameraView {
    const picture = this.picture(now);
    if (picture.kind === "view") return picture.view;
    return picture.mix < 0.5 ? picture.from.view : picture.to.view;
  }

  /**
   * Goes to a goal along a transition. From rest the transition is planned
   * from the view on screen; a running motion is broken off and the
   * transition follows from where it comes to rest.
   */
  to(leg: Leg, now: number): void {
    this.#advance(now);
    const run = this.#run;
    if (run === null) {
      const space = this.#common(this.#view.space, leg.goal.view.space);
      const from = this.#in(this.#view, space);
      const to = this.#in(leg.goal.view, space);
      let motion: CameraMotion;
      try {
        motion = guardComfort(
          leg.transition.plan({
            from,
            to,
            options: leg.options,
            comfort: this.#comfort,
            viewport: this.#screen,
          }),
          from,
          to,
          this.#comfort,
        );
      } catch {
        // A transition that cannot plan: the goal is shown at once.
        motion = still(to);
      }
      this.#begin(motion, now, space, leg, to, [
        { view: from, hidden: this.#hidden },
        { view: to, hidden: leg.goal.hidden },
      ]);
      return;
    }
    const to = this.#in(leg.goal.view, run.space);
    let motion: CameraMotion;
    try {
      motion = breakOff(this.#played(run), now - run.start, this.#comfort, {
        transition: leg.transition,
        options: leg.options,
        to,
        viewport: this.#screen,
      });
    } catch {
      motion = still(to);
    }
    this.#begin(motion, now, run.space, leg, to, [
      ...this.#marks(run, now),
      { view: to, hidden: leg.goal.hidden },
    ]);
  }

  /**
   * The goal of the running motion is seen anew: the screen changed size or
   * the document changed. The same goal changes nothing, and what the goal
   * hides changing is taken over without touching the motion. A goal that
   * moved is steered onto (steer.ts): always when the screen changed size,
   * and when the document moved it by less than STEER_LIMIT; otherwise the
   * motion is broken off as for a new goal (`to`). Without a running motion
   * with a goal, this is `to`.
   */
  follow(leg: Leg, now: number, change: GoalChange): void {
    this.#advance(now);
    const run = this.#run;
    if (run === null || run.leg === null) {
      this.to(leg, now);
      return;
    }
    const old = run.leg.goal;
    const hidden = sameMembers(old.hidden, leg.goal.hidden)
      ? old.hidden
      : leg.goal.hidden;
    if (hidden !== old.hidden) {
      // What the goal shows on arrival changed: its mark says so.
      run.marks = run.marks.map((m) =>
        m.hidden === old.hidden && run.to !== null && sameView(m.view, run.to)
          ? { view: m.view, hidden }
          : m,
      );
    }
    if (sameView(old.view, leg.goal.view)) {
      run.leg = { ...leg, goal: { view: old.view, hidden } };
      return;
    }
    if (run.to === null) {
      this.to(leg, now);
      return;
    }
    const time = now - run.start;
    const to = this.#in(leg.goal.view, run.space);
    const was = this.#in(old.view, run.space);
    // Spread over what is left of the motion, or a little longer, but never
    // past a little after the motion's own end: goals that keep moving must
    // not keep the camera from arriving.
    const end = Math.max(
      run.duration,
      Math.min(time + MIN_STEER_MS, run.motionDuration + MIN_STEER_MS),
    );
    // A move the document made is steered onto only if it is small, and
    // the time left is enough for it at no more than the speed of the
    // largest such move spread over MIN_STEER_MS.
    const gap = this.#gap(was, to);
    if (
      change === "document" &&
      (gap >= STEER_LIMIT || gap * MIN_STEER_MS > STEER_LIMIT * (end - time))
    ) {
      this.to(leg, now);
      return;
    }
    if (run.steer === null) {
      const frame = this.#frame(run, time);
      const here =
        frame.kind === "view"
          ? frame.view
          : sameView(frame.from, run.to)
            ? frame.to
            : frame.from;
      run.reachWidth = this.#screen.width;
      run.reach = gapOf(here, run.to, run.reachWidth);
    }
    run.steer = steer(run.steer, time, end, shiftBetween(run.to, to));
    run.duration = end;
    run.leg = { ...leg, goal: { view: leg.goal.view, hidden } };
  }

  #gap(a: CameraView, b: CameraView): number {
    return gapOf(a, b, this.#screen.width);
  }

  /** New comfort settings: a transition that is running goes on to its goal under them. */
  setComfort(comfort: ComfortSettings, now: number): void {
    this.#advance(now);
    this.#comfort = comfort;
    const run = this.#run;
    if (run === null) return;
    if (run.leg !== null) this.to(run.leg, now);
    // Coming to rest along a flight: with reduced motion it stops where it is.
    else if (comfort.reducedMotion) this.#halt(run, now);
  }

  /** The presenter moves the picture by (dx, dy) pixels. */
  pan(dx: number, dy: number, now: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
    const run = this.#takeOver(now);
    if (run !== null) run.nudge = panNudge(run.nudge, dx, dy);
    else
      this.#view = this.#spaces.place(nudgeView(this.#view, panNudge(NO_NUDGE, dx, dy)));
  }

  /**
   * The presenter zooms by `factor` about the point (ax, ay), in pixels from
   * the centre of the screen; the point stays where it is.
   */
  zoomAt(ax: number, ay: number, factor: number, now: number): void {
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) return;
    const run = this.#takeOver(now);
    if (run === null) {
      this.#view = this.#spaces.zoomAbout(this.#view, ax, ay, factor);
      return;
    }
    const f = limitFactor(this.current(now).zoom, factor);
    if (f !== 1) run.nudge = zoomNudge(run.nudge, ax, ay, f);
  }

  /** Leaves a transition that is running to come to rest by itself. */
  halt(now: number): void {
    this.#takeOver(now);
  }

  /**
   * The presenter takes the camera: a transition that is running is left to
   * come to rest by itself (breakOff without a next transition), and what the
   * presenter does is laid over it. Returns the motion still running, if any.
   */
  #takeOver(now: number): Run | null {
    this.#advance(now);
    const run = this.#run;
    if (run === null || run.leg === null) return run;
    return this.#halt(run, now);
  }

  /** Breaks a motion off without a next one; returns what is left of it, if anything. */
  #halt(run: Run, now: number): Run | null {
    const time = now - run.start;
    let motion: CameraMotion;
    try {
      motion = breakOff(this.#played(run), time, this.#comfort);
    } catch {
      motion = still(this.#show(run, dominant(this.#frame(run, time)), now));
    }
    return this.#begin(motion, now, run.space, null, null, this.#marks(run, now));
  }

  /** Starts a motion; one without duration is over at once. */
  #begin(
    motion: CameraMotion,
    now: number,
    space: ElementId | null,
    leg: Leg | null,
    to: CameraView | null,
    marks: readonly Shot[],
  ): Run | null {
    const duration = durationOf(motion);
    const run: Run = {
      motion,
      motionDuration: duration,
      duration,
      start: now,
      space,
      leg,
      to,
      steer: null,
      reach: 0,
      reachWidth: 1,
      marks,
      nudge: NO_NUDGE,
    };
    this.#run = run;
    this.#advance(now);
    return this.#run;
  }

  /** Ends the motion if its time is up. */
  #advance(now: number): void {
    const run = this.#run;
    if (run === null || now - run.start < run.duration) return;
    this.#run = null;
    if (run.leg !== null) {
      // Arrived: exactly the goal, in the space it is anchored in.
      this.#view = run.leg.goal.view;
      this.#hidden = run.leg.goal.hidden;
      return;
    }
    const view = dominant(this.#frame(run, run.duration));
    const known = run.marks.find((m) => sameView(m.view, view));
    if (known !== undefined) this.#hidden = known.hidden;
    this.#view = this.#spaces.place(this.#show(run, view, run.start + run.duration));
  }

  /** A view of the motion as it is on screen at `now`: corrected and nudged. */
  #show(run: Run, view: CameraView, now: number): CameraView {
    return nudgeView(shiftView(view, this.#shift(run, view, now - run.start)), run.nudge);
  }

  /** The correction of a view of the motion at `time` (the motion's own time). */
  #shift(run: Run, view: CameraView, time: number): Shift {
    if (run.steer === null || run.to === null) return NO_SHIFT;
    const to = run.to;
    let weight: number;
    if (sameView(view, to)) weight = 1;
    else if (!(run.reach > 0)) weight = 0;
    else
      weight = Math.min(1, Math.max(0, 1 - gapOf(view, to, run.reachWidth) / run.reach));
    if (weight === 0) return NO_SHIFT;
    const s = shiftAt(run.steer, time);
    return { x: s.x * weight, y: s.y * weight, z: s.z * weight };
  }

  /** Every view of a frame of the motion, corrected as at `time`. */
  #shiftFrame(run: Run, frame: MotionFrame, time: number): MotionFrame {
    if (run.steer === null) return frame;
    if (frame.kind === "view")
      return {
        kind: "view",
        view: shiftView(frame.view, this.#shift(run, frame.view, time)),
      };
    return {
      kind: "blend",
      from: shiftView(frame.from, this.#shift(run, frame.from, time)),
      to: shiftView(frame.to, this.#shift(run, frame.to, time)),
      mix: frame.mix,
    };
  }

  /** A frame of the motion, without the nudge. A motion that throws shows where it was heading. */
  #frame(run: Run, time: number): MotionFrame {
    try {
      return run.motion.frame(Math.min(Math.max(time, 0), run.motionDuration));
    } catch {
      return { kind: "view", view: run.to ?? this.#in(this.#view, run.space) };
    }
  }

  /** The motion as it is on screen: corrected for a moved goal, and with the presenter's nudge. */
  #played(run: Run): CameraMotion {
    const { nudge, steer: course } = run;
    if (nudge === NO_NUDGE && course === null) return run.motion;
    const raw = (time: number): MotionFrame =>
      run.motion.frame(Math.min(Math.max(time, 0), run.motionDuration));
    return {
      duration: run.duration,
      frame: (time) => nudgeFrame(this.#shiftFrame(run, raw(time), time), nudge),
    };
  }

  /** The marks as they are on screen at `now`: corrected, and with the presenter's nudge. */
  #marks(run: Run, now: number): readonly Shot[] {
    const { nudge, steer: course } = run;
    if (nudge === NO_NUDGE && course === null) return run.marks;
    const time = now - run.start;
    return run.marks.map((m) => ({
      view: nudgeView(shiftView(m.view, this.#shift(run, m.view, time)), nudge),
      hidden: m.hidden,
    }));
  }

  /** The containers from `space` up to the root (null last). */
  #chain(space: ElementId | null): (ElementId | null)[] {
    const out: (ElementId | null)[] = [];
    const seen = new Set<ElementId>();
    for (let at = space; at !== null && !seen.has(at); at = this.#spaces.parentOf(at)) {
      seen.add(at);
      out.push(at);
    }
    out.push(null);
    return out;
  }

  /** The lowest space both are in. */
  #common(a: ElementId | null, b: ElementId | null): ElementId | null {
    if (a === b) return a;
    const ups = new Set(this.#chain(a));
    return this.#chain(b).find((space) => ups.has(space)) ?? null;
  }

  /** A view carried into another space (exact: through their lowest common ancestor). */
  #in(view: CameraView, space: ElementId | null): CameraView {
    if (view.space === space) return view;
    const o = this.#spaces.offset(view.space, space);
    return { space, cx: view.cx + o.x, cy: view.cy + o.y, zoom: view.zoom };
  }
}
