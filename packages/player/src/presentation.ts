// SPDX-License-Identifier: GPL-3.0-or-later

// A presentation: a route of stops played through the camera. The state is
// small: the route, the stop that was shown last, the stop the camera is on
// its way to, and whether the presenter has left the route.
//
// - "stop": the camera shows a stop of the route.
// - "moving": it is on its way to one, along that stop's transition.
// - "roaming": the presenter moved the camera. The route is paused: what the
//   last stop showed and hid stays, "back" returns to that stop, and "next"
//   goes on to the stop after it.
//
// Every input is accepted in every state and at any time, also in the middle
// of a transition: the camera (playback.ts) continues from what is on screen,
// without a jump. See docs/adr/0015-presentation.md.

import {
  hiddenAt,
  stopRegion,
  type CameraView,
  type Json,
  type RouteId,
} from "@galatsa/core";
import {
  readTransitionValue,
  type AnyTransition,
  type ComfortSettings,
  type ContributionId,
} from "@galatsa/extension-api";
import {
  DEFAULT_COMFORT_PREFERENCES,
  FLIGHT_LIMITS_SETTING,
  fly,
  readFlightLimits,
  resolveComfort,
  withoutFlightLimits,
  type ComfortPreferences,
} from "@galatsa/extension-transitions";
import {
  readRoutes,
  readSteps,
  viewOfRegion,
  type PresentationSource,
  type RouteInfo,
  type Screen,
  type Step,
  type StopsAndRoutes,
} from "./model.ts";
import {
  Playback,
  type GoalChange,
  type Hidden,
  type Leg,
  type Picture,
  type Shot,
  sameMembers,
} from "./playback.ts";
import { Anchor } from "./roam.ts";

export type Phase = "stop" | "moving" | "roaming";

export interface PresentationState {
  /** The routes that can be played, in list order. */
  readonly routes: readonly RouteInfo[];
  /** The route being played; null when the document has none. */
  readonly route: RouteId | null;
  /** Its steps, in playing order. */
  readonly steps: readonly Step[];
  /**
   * The step the presentation is at: the stop shown, the stop it is on its
   * way to, or, while roaming, the stop shown last. -1 when there is none.
   */
  readonly position: number;
  readonly phase: Phase;
  /** Whether the camera moves without motion now (cross-fades only). */
  readonly reducedMotion: boolean;
  /** The presenter's own choice of that for this presentation; null: as set up. */
  readonly motionChoice: boolean | null;
}

export interface PresentationOptions {
  readonly source: PresentationSource;
  readonly screen: Screen;
  /**
   * Looks a transition up by its id (the viewing host's `transition`). A stop
   * that names none, or one that is not found, flies (the route's default).
   */
  readonly transitions?: (id: ContributionId) => AnyTransition | undefined;
  /** Milliseconds from any fixed start; default the platform's clock. */
  readonly now?: () => number;
  /** The user's comfort settings; default the calm defaults, following the system. */
  readonly preferences?: ComfortPreferences;
  /** The system's "reduce motion" setting. */
  readonly systemReducedMotion?: boolean;
  /** The route to play; default the first. */
  readonly route?: RouteId | null;
  /** The step to start at; default the first. */
  readonly step?: number;
  /** What to show when there is no stop to start at. */
  readonly view?: CameraView;
}

const NOTHING: Hidden = new Set();
const ORIGIN: CameraView = { space: null, cx: 0, cy: 0, zoom: 1 };

function defaultClock(): () => number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? () => p.now() : () => Date.now();
}

export class Presentation {
  readonly #source: PresentationSource;
  readonly #now: () => number;
  readonly #transitions: (id: ContributionId) => AnyTransition | undefined;
  readonly #preferences: ComfortPreferences;
  readonly #anchor: Anchor;
  readonly #playback: Playback;
  readonly #listeners = new Set<() => void>();
  readonly #hidden = new Map<number, Hidden>();
  #system: boolean;
  #choice: boolean | null = null;
  /** The document's motion sickness guard (FLIGHT_LIMITS_SETTING). */
  #limits: boolean;
  #sr: StopsAndRoutes;
  #routes: RouteInfo[];
  #route: RouteId | null;
  #steps: Step[];
  /** The step shown last: where "back" returns to. */
  #at: number;
  /** The step the camera is on its way to (while moving). */
  #target: number;
  #phase: Phase;
  #state: PresentationState | null = null;

  constructor(options: PresentationOptions) {
    this.#source = options.source;
    this.#now = options.now ?? defaultClock();
    this.#transitions = options.transitions ?? (() => undefined);
    this.#preferences = options.preferences ?? DEFAULT_COMFORT_PREFERENCES;
    this.#system = options.systemReducedMotion ?? false;
    this.#limits = this.#readLimits();
    this.#sr = this.#source.stopsAndRoutes();
    this.#routes = readRoutes(this.#sr);
    const wanted = options.route ?? null;
    this.#route = this.#routes.some((r) => r.id === wanted)
      ? wanted
      : (this.#routes[0]?.id ?? null);
    this.#steps = readSteps(this.#source, this.#sr, this.#route);
    this.#at = this.#steps.length === 0 ? -1 : this.#clamp(options.step ?? 0);
    this.#target = this.#at;
    this.#phase = this.#at < 0 ? "roaming" : "stop";
    const resolver = this.#source.resolver;
    this.#anchor = new Anchor(resolver);
    const first = this.#at < 0 ? null : this.#shot(this.#at, options.screen);
    this.#playback = new Playback({
      view: first?.view ?? options.view ?? ORIGIN,
      hidden: first?.hidden ?? NOTHING,
      comfort: this.#comfort(),
      screen: options.screen,
      spaces: {
        offset: (from, to) => resolver.offset(from, to),
        parentOf: (id) => resolver.parentOf(id),
        place: (view) => this.#anchor.place(view),
        zoomAbout: (view, ax, ay, factor) => this.#anchor.zoomAbout(view, ax, ay, factor),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  get state(): PresentationState {
    this.#settle();
    this.#state ??= {
      routes: this.#routes,
      route: this.#route,
      steps: this.#steps,
      position: this.#phase === "moving" ? this.#target : this.#at,
      phase: this.#phase,
      reducedMotion: this.#comfort().reducedMotion,
      motionChoice: this.#choice,
    };
    return this.#state;
  }

  /** What the screen shows now (or at `now`). */
  picture(now: number = this.#now()): Picture {
    const picture = this.#playback.picture(now);
    this.#settle(now);
    return picture;
  }

  /** True while the camera is in motion: more frames are to be drawn. */
  get moving(): boolean {
    return this.#playback.moving(this.#now());
  }

  /** Calls `listener` when the state changes; returns how to stop. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // The route
  // -------------------------------------------------------------------------

  /**
   * The next stop. While roaming: the stop after the one shown last (the
   * route goes on from where it was left), or back to that stop if it was the
   * route's last. At the last stop nothing happens.
   */
  next(): void {
    this.#settle();
    const base = this.#phase === "moving" ? this.#target : this.#at;
    if (base + 1 < this.#steps.length) this.#travel(base + 1);
    else if (this.#phase === "roaming") this.back();
  }

  /** The stop before. While roaming: back to the stop shown last. */
  previous(): void {
    this.#settle();
    if (this.#phase === "roaming") this.back();
    else {
      const base = this.#phase === "moving" ? this.#target : this.#at;
      if (base > 0) this.#travel(base - 1);
    }
  }

  /** After roaming: back to the stop shown last. Otherwise nothing. */
  back(): void {
    this.#settle();
    if (this.#phase === "roaming" && this.#at >= 0) this.#travel(this.#at);
  }

  /** Jumps to a step of the route (0 is the first), along that stop's transition. */
  goTo(index: number): void {
    this.#settle();
    if (!Number.isInteger(index) || index < 0 || index >= this.#steps.length) return;
    // The stop shown, or the one the camera is on its way to: nothing to do.
    if (this.#phase === "stop" && index === this.#at) return;
    if (this.#phase === "moving" && index === this.#target) return;
    this.#travel(index);
  }

  /**
   * Plays another route. If it visits the stop shown last, it goes on from
   * there (its first visit to it); otherwise from its first stop.
   */
  setRoute(route: RouteId): void {
    this.#settle();
    if (route === this.#route || !this.#routes.some((r) => r.id === route)) return;
    const stop = this.#steps[this.#at]?.stop;
    this.#route = route;
    this.#rereadSteps();
    const same = stop === undefined ? -1 : this.#steps.findIndex((s) => s.stop === stop);
    const now = this.#now();
    this.#at = same;
    if (this.#steps.length === 0) this.#stranded(now);
    else if (same >= 0 && this.#phase === "roaming")
      this.#playback.setHidden(this.#hiddenAt(same), now);
    else {
      // At the same stop the camera stays, and what the new route shows and
      // hides there takes over; otherwise the new route starts.
      this.#travel(Math.max(same, 0));
      return;
    }
    this.#emit();
  }

  // -------------------------------------------------------------------------
  // Free roaming
  // -------------------------------------------------------------------------

  /** Moves the picture by a distance in CSS pixels. The route is paused. */
  pan(dx: number, dy: number): void {
    this.#playback.pan(dx, dy, this.#now());
    this.#roaming();
  }

  /** Zooms by `factor` about a point on screen (CSS pixels), which stays where it is. */
  zoomAt(point: { readonly x: number; readonly y: number }, factor: number): void {
    const screen = this.#playback.screen;
    this.#playback.zoomAt(
      point.x - screen.width / 2,
      point.y - screen.height / 2,
      factor,
      this.#now(),
    );
    this.#roaming();
  }

  /**
   * Two fingers moved: the point of the canvas that was at `from` is now at
   * `to`, and the picture is scaled by `factor`.
   */
  pinch(
    from: { readonly x: number; readonly y: number },
    to: { readonly x: number; readonly y: number },
    factor: number,
  ): void {
    this.zoomAt(from, factor);
    this.pan(to.x - from.x, to.y - from.y);
  }

  #roaming(): void {
    if (this.#phase === "roaming") return;
    this.#settle();
    this.#phase = "roaming";
    this.#emit();
  }

  // -------------------------------------------------------------------------
  // Comfort
  // -------------------------------------------------------------------------

  /**
   * The presenter's choice for this presentation: true for no camera motion
   * (every transition is a cross-fade), false to allow motion, null to follow
   * the settings and the system.
   */
  setReducedMotion(choice: boolean | null): void {
    if (choice === this.#choice) return;
    this.#choice = choice;
    this.#comfortChanged();
  }

  /** The system's "reduce motion" setting changed. */
  setSystemReducedMotion(reduced: boolean): void {
    if (reduced === this.#system) return;
    this.#system = reduced;
    this.#comfortChanged();
  }

  /**
   * The comfort settings transitions are planned with. With the document's
   * motion sickness guard off the flight limits do not apply (the camera
   * flies however far); reduced motion still wins.
   */
  #comfort(): ComfortSettings {
    const comfort = resolveComfort(this.#preferences, this.#system, this.#choice);
    return this.#limits ? comfort : withoutFlightLimits(comfort);
  }

  #readLimits(): boolean {
    return readFlightLimits(this.#source.setting?.(FLIGHT_LIMITS_SETTING));
  }

  #comfortChanged(): void {
    // A transition that is running goes on to the same goal under the new
    // settings (docs/adr/0005, section 7).
    this.#playback.setComfort(this.#comfort(), this.#now());
    this.#emit();
  }

  // -------------------------------------------------------------------------
  // The surroundings
  // -------------------------------------------------------------------------

  /** The size of the drawing area changed: a stop is fitted to the new size. */
  resize(screen: Screen): void {
    const old = this.#playback.screen;
    if (old.width === screen.width && old.height === screen.height) return;
    this.#settle();
    this.#playback.setScreen(screen);
    this.#refit("resize");
  }

  /**
   * The document changed: the routes, the steps, where the stops are and what
   * they hide are read again. The presentation stays at the same visit of the
   * route where it still exists.
   */
  documentChanged(): void {
    this.#settle();
    this.#anchor.invalidate();
    this.#sr = this.#source.stopsAndRoutes();
    this.#routes = readRoutes(this.#sr);
    const at = this.#steps[this.#at]?.entry;
    const target = this.#steps[this.#target]?.entry;
    const hiddenBefore = this.#at < 0 ? NOTHING : this.#hiddenAt(this.#at);
    if (!this.#routes.some((r) => r.id === this.#route))
      this.#route = this.#routes[0]?.id ?? null;
    this.#rereadSteps();
    const find = (entry: string | undefined, fallback: number): number => {
      const found =
        entry === undefined ? -1 : this.#steps.findIndex((s) => s.entry === entry);
      return found >= 0 ? found : this.#clamp(fallback);
    };
    if (this.#steps.length === 0) this.#stranded(this.#now());
    else {
      if (this.#at >= 0) this.#at = find(at, this.#at);
      this.#target = find(target, this.#target);
      this.#refit("document", hiddenBefore);
    }
    // The motion sickness guard switched: a running transition goes on to
    // the same goal under the new settings.
    const limits = this.#readLimits();
    if (limits !== this.#limits) {
      this.#limits = limits;
      this.#playback.setComfort(this.#comfort(), this.#now());
    }
    this.#emit();
  }

  /** The route has no stops (any more): the camera is the presenter's. */
  #stranded(now: number): void {
    this.#at = -1;
    this.#target = -1;
    // A transition that was running comes to rest by itself.
    this.#playback.halt(now);
    this.#playback.setHidden(NOTHING, now);
    this.#phase = "roaming";
  }

  /**
   * Shows the stop as it is now: where it is, at this screen size, with what
   * it hides. A transition on its way there goes on undisturbed when the goal
   * is the same, and is steered onto it when it moved a little (playback.ts).
   */
  #refit(change: GoalChange, hiddenBefore?: Hidden): void {
    const now = this.#now();
    if (this.#phase === "stop") this.#playback.rest(this.#goal(this.#at));
    else if (this.#phase === "moving")
      this.#playback.follow(this.#leg(this.#target), now, change);
    else if (hiddenBefore !== undefined) {
      // Roaming: what the stop shown last hides is shown as it is now, if the
      // document changed it; otherwise the picture is left as it is.
      const hidden = this.#at < 0 ? NOTHING : this.#hiddenAt(this.#at);
      if (!sameMembers(hidden, hiddenBefore)) this.#playback.setHidden(hidden, now);
    }
  }

  // -------------------------------------------------------------------------
  // Inside
  // -------------------------------------------------------------------------

  #clamp(index: number): number {
    const last = this.#steps.length - 1;
    return Number.isFinite(index) ? Math.min(Math.max(Math.trunc(index), 0), last) : 0;
  }

  #rereadSteps(): void {
    this.#steps = readSteps(this.#source, this.#sr, this.#route);
    this.#hidden.clear();
  }

  /** What the route hides at a step, as one set per step until the document changes. */
  #hiddenAt(index: number): Hidden {
    let hidden = this.#hidden.get(index);
    if (hidden === undefined) {
      const step = this.#steps[index];
      hidden =
        this.#route !== null && step !== undefined
          ? hiddenAt(this.#sr, this.#route, step.place)
          : NOTHING;
      this.#hidden.set(index, hidden);
    }
    return hidden;
  }

  /** A step as the screen shows it at rest; the view is null if the stop shows nothing now. */
  #shot(index: number, screen: Screen): { view: CameraView | null; hidden: Hidden } {
    const step = this.#steps[index];
    const region = step ? stopRegion(this.#sr, this.#source.resolver, step.stop) : null;
    return {
      view: region !== null ? viewOfRegion(region, screen) : null,
      hidden: this.#hiddenAt(index),
    };
  }

  #goal(index: number): Shot {
    const shot = this.#shot(index, this.#playback.screen);
    // A stop that shows nothing any more leaves the camera where it is.
    return {
      view: shot.view ?? this.#playback.current(this.#now()),
      hidden: shot.hidden,
    };
  }

  /** The way to a step: its goal, and the transition into its stop. */
  #leg(index: number): Leg {
    const stop = this.#sr.stops[this.#steps[index]?.stop ?? ""];
    const value = readTransitionValue((stop?.transition ?? null) as Json);
    const transition: AnyTransition =
      (value !== null ? this.#transitions(value.type) : undefined) ??
      (fly as AnyTransition);
    let options: unknown;
    try {
      options = transition.read(value?.options ?? null);
    } catch {
      options = null;
    }
    return { goal: this.#goal(index), transition, options };
  }

  #travel(index: number): void {
    const now = this.#now();
    this.#target = index;
    this.#playback.to(this.#leg(index), now);
    if (this.#playback.moving(now)) this.#phase = "moving";
    else {
      this.#phase = "stop";
      this.#at = index;
    }
    this.#emit();
  }

  /** Notices that the camera has arrived. */
  #settle(now: number = this.#now()): void {
    if (this.#phase !== "moving" || this.#playback.moving(now)) return;
    this.#phase = "stop";
    this.#at = this.#target;
    this.#emit();
  }

  #emit(): void {
    this.#state = null;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        console.error(error);
      }
    }
  }
}
