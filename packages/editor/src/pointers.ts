// SPDX-License-Identifier: GPL-3.0-or-later

// Which pointer the canvas follows, apart from the DOM so it can be tested:
//
// - The primary button (left mouse button, a pen or a finger) goes to the
//   current tool, from down to up. The middle button drags the canvas. Other
//   buttons (the right button, which opens a context menu) are not the tool's.
// - One pointer at a time: while one is down, other pointers are ignored (a
//   second finger), unless the one that is down has gone without its
//   pointerup. That happens: a context menu, another window or the system can
//   take a press so that its pointerup never arrives. So a pointer counts as
//   gone when the same pointer goes down again, when it moves with no button
//   down, or when the page no longer holds its capture; the tool's drag is then
//   cancelled, and the new press is taken.

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
  /** A mouse moving with nothing down: tools may show where they would act. */
  | { readonly kind: "hover" }
  | { readonly kind: "pan"; readonly dx: number; readonly dy: number }
  /** Capture this pointer (it went down and is followed). */
  | { readonly kind: "capture" }
  /** Release the capture of this pointer. */
  | { readonly kind: "release"; readonly id: number };

interface Active {
  readonly id: number;
  readonly pan: boolean;
  x: number;
  y: number;
}

export class PointerTracker {
  #active: Active | null = null;

  /** The pointer followed now, if any. */
  get active(): number | null {
    return this.#active?.id ?? null;
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
    const out: PointerAction[] = [];
    if (this.#active !== null) {
      if (this.#active.id !== e.id && activeCaptured) return []; // a second finger
      out.push(...this.#drop());
    }
    const pan = e.button === 1;
    if (!pan && e.button !== 0) return out;
    // The same pointer is captured again at once: releasing it first would
    // send a lostpointercapture that ends the new press.
    const kept = out.filter((a) => !(a.kind === "release" && a.id === e.id));
    out.splice(0, out.length, ...kept);
    this.#active = { id: e.id, pan, x: e.x, y: e.y };
    out.push({ kind: "capture" });
    if (!pan) out.push({ kind: "tool-down" });
    return out;
  }

  move(e: PointerFacts): PointerAction[] {
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
    return [{ kind: "tool-move" }];
  }

  up(e: PointerFacts): PointerAction[] {
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
    if (this.#active === null || e.id !== this.#active.id) return [];
    const pan = this.#active.pan;
    this.#active = null;
    return pan ? [] : [{ kind: "tool-cancel" }];
  }
}
