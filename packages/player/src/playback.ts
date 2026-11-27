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

/** A motion being played. */
interface Run {
  /** As it is played: guarded, and from its own time 0. */
  readonly motion: CameraMotion;
  readonly duration: number;
  /** When it started. */
  readonly start: number;
  /** The space its views are in. */
  readonly space: ElementId | null;
  /** Where it is heading; null when it only comes to rest, for the presenter. */
  readonly leg: Leg | null;
  /** The goal's view in `space`. */
  readonly to: CameraView | null;
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
      return { kind: "view", view: nudgeView(view, run.nudge), hidden: this.#hidden };
    }
    const side = (view: CameraView): Shot => ({
      view: nudgeView(view, run.nudge),
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
      ...this.#marks(run),
      { view: to, hidden: leg.goal.hidden },
    ]);
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
      motion = still(nudgeView(dominant(this.#frame(run, time)), run.nudge));
    }
    return this.#begin(motion, now, run.space, null, null, this.#marks(run));
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
    const run: Run = {
      motion,
      duration: durationOf(motion),
      start: now,
      space,
      leg,
      to,
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
    this.#view = this.#spaces.place(nudgeView(view, run.nudge));
  }

  /** A frame of the motion, without the nudge. A motion that throws shows where it was heading. */
  #frame(run: Run, time: number): MotionFrame {
    try {
      return run.motion.frame(Math.min(Math.max(time, 0), run.duration));
    } catch {
      return { kind: "view", view: run.to ?? this.#in(this.#view, run.space) };
    }
  }

  /** The motion as it is on screen: with the presenter's nudge. */
  #played(run: Run): CameraMotion {
    const nudge = run.nudge;
    if (nudge === NO_NUDGE) return run.motion;
    return {
      duration: run.duration,
      frame: (time) => nudgeFrame(run.motion.frame(time), nudge),
    };
  }

  /** The marks as they are on screen: with the presenter's nudge. */
  #marks(run: Run): readonly Shot[] {
    const nudge = run.nudge;
    if (nudge === NO_NUDGE) return run.marks;
    return run.marks.map((m) => ({ view: nudgeView(m.view, nudge), hidden: m.hidden }));
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
