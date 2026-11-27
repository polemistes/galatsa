// SPDX-License-Identifier: GPL-3.0-or-later

// Which pointer the canvas follows, apart from the DOM so it can be tested:
//
// - The primary button (left mouse button, a pen or a finger) goes to the
//   current tool, from down to up. The middle button drags the canvas. Other
//   buttons (the right button, which opens a context menu) are not the tool's.
// - One pointer at a time for the tool: while one is down, other pointers are
//   ignored, unless the one that is down has gone without its pointerup. That
//   happens: a context menu, another window or the system can take a press so
//   that its pointerup never arrives. So a pointer counts as gone when the
//   same pointer goes down again, when it moves with no button down, or when
//   the page no longer holds its capture; the tool's drag is then cancelled,
//   and the new press is taken.
// - Two fingers hold the canvas: a second touch while a finger is down takes
//   the first finger's press back from the tool (its drag is cancelled, and a
//   selection it made is undone), and from then on the two fingers pan and
//   pinch the view. When one is lifted, the other drags the
//   canvas until it is lifted too; a third finger is ignored. Touch pointers
//   are not checked for a lost capture, because browsers end them with
//   pointercancel.

import type { Point } from "@galatsa/core";

/** The facts of a DOM pointer event the tracker reads. */
export interface PointerFacts {
  readonly id: number;
  readonly type: string;
  /** The button that changed (0 primary, 1 middle, 2 secondary). */
  readonly button: number;
  /** The buttons held down now, as a bit mask. */
  readonly buttons: number;
  /** Screen position, CSS pixels. */
  readonly x: number;
  readonly y: number;
}

export type PointerAction =
  | { readonly kind: "tool-down" }
  | { readonly kind: "tool-move" }
  | { readonly kind: "tool-up" }
  | { readonly kind: "tool-cancel" }
  /**
   * The first finger's press was the start of a pinch: the tool's drag is
   * cancelled and what the press did (a selection) is taken back.
   */
  | { readonly kind: "tool-withdraw" }
  /** A mouse moving with nothing down: tools may show where they would act. */
  | { readonly kind: "hover" }
  | { readonly kind: "pan"; readonly dx: number; readonly dy: number }
  /**
   * Two fingers moved: the point between them went from `from` to `to`
   * (positions as given, CSS pixels) and their distance changed by `factor`.
   */
  | {
      readonly kind: "pinch";
      readonly from: Point;
      readonly to: Point;
      readonly factor: number;
    }
  /** Capture this pointer (it went down and is followed). */
  | { readonly kind: "capture" }
  /** Release the capture of this pointer. */
  | { readonly kind: "release"; readonly id: number };

interface Active {
  readonly id: number;
  readonly type: string;
  readonly pan: boolean;
  x: number;
  y: number;
}

interface Finger {
  readonly id: number;
  x: number;
  y: number;
}

export class PointerTracker {
  #active: Active | null = null;
  /** The two fingers of a pinch, while there is one. */
  #pinch: [Finger, Finger] | null = null;

  /** The pointer followed now, if any (the first finger of a pinch). */
  get active(): number | null {
    return this.#pinch?.[0].id ?? this.#active?.id ?? null;
  }

  /** Whether two fingers hold the canvas now. */
  get pinching(): boolean {
    return this.#pinch !== null;
  }

  /** Ends the pointer followed now without its pointerup. */
  #drop(): PointerAction[] {
    const was = this.#active;
    if (was === null) return [];
    this.#active = null;
    return [
      { kind: "release", id: was.id },
      ...(was.pan ? [] : [{ kind: "tool-cancel" } as const]),
    ];
  }

  /**
   * A pointer went down. `activeCaptured`: whether the page still holds the
   * capture of the pointer followed now.
   */
  down(e: PointerFacts, activeCaptured: boolean): PointerAction[] {
    if (this.#pinch !== null) return []; // a third finger
    const active = this.#active;
    if (
      active !== null &&
      active.type === "touch" &&
      e.type === "touch" &&
      active.id !== e.id
    ) {
      // A second finger: the two hold the canvas.
      this.#active = null;
      this.#pinch = [
        { id: active.id, x: active.x, y: active.y },
        { id: e.id, x: e.x, y: e.y },
      ];
      return [
        ...(active.pan ? [] : [{ kind: "tool-withdraw" } as const]),
        { kind: "capture" },
      ];
    }
    const out: PointerAction[] = [];
    if (active !== null) {
      if (active.id !== e.id && activeCaptured) return []; // another pointer
      out.push(...this.#drop());
    }
    const pan = e.button === 1;
    if (!pan && e.button !== 0) return out;
    // The same pointer is captured again at once: releasing it first would
    // send a lostpointercapture that ends the new press.
    const kept = out.filter((a) => !(a.kind === "release" && a.id === e.id));
    out.splice(0, out.length, ...kept);
    this.#active = { id: e.id, type: e.type, pan, x: e.x, y: e.y };
    out.push({ kind: "capture" });
    if (!pan) out.push({ kind: "tool-down" });
    return out;
  }

  move(e: PointerFacts): PointerAction[] {
    const pinch = this.#pinch;
    if (pinch !== null) {
      const finger = pinch.find((f) => f.id === e.id);
      if (finger === undefined) return [];
      const [a, b] = pinch;
      const from = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      finger.x = e.x;
      finger.y = e.y;
      const to = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      const factor = before > 0 && after > 0 ? after / before : 1;
      return [{ kind: "pinch", from, to, factor }];
    }
    const active = this.#active;
    if (active === null) return e.type === "mouse" ? [{ kind: "hover" }] : [];
    if (e.id !== active.id) return [];
    if (e.buttons === 0) return this.#drop(); // released without a pointerup
    if (active.pan) {
      const dx = e.x - active.x;
      const dy = e.y - active.y;
      active.x = e.x;
      active.y = e.y;
      return [{ kind: "pan", dx, dy }];
    }
    active.x = e.x;
    active.y = e.y;
    return [{ kind: "tool-move" }];
  }

  /** One finger of a pinch ended: the other drags the canvas. */
  #endFinger(id: number): boolean {
    const pinch = this.#pinch;
    if (pinch === null || !pinch.some((f) => f.id === id)) return false;
    const rest = pinch[0].id === id ? pinch[1] : pinch[0];
    this.#pinch = null;
    this.#active = { id: rest.id, type: "touch", pan: true, x: rest.x, y: rest.y };
    return true;
  }

  up(e: PointerFacts): PointerAction[] {
    if (this.#endFinger(e.id)) return [{ kind: "release", id: e.id }];
    const active = this.#active;
    if (active === null || e.id !== active.id) return [];
    this.#active = null;
    return [
      { kind: "release", id: e.id },
      ...(active.pan ? [] : [{ kind: "tool-up" } as const]),
    ];
  }

  /** The pointer was cancelled or lost its capture. */
  cancel(e: Pick<PointerFacts, "id">): PointerAction[] {
    if (this.#endFinger(e.id)) return [];
    if (this.#active === null || e.id !== this.#active.id) return [];
    const pan = this.#active.pan;
    this.#active = null;
    return pan ? [] : [{ kind: "tool-cancel" }];
  }
}
