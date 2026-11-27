// SPDX-License-Identifier: GPL-3.0-or-later

// What a key does in a presentation. Presentation clickers are keyboards:
// most send PageDown and PageUp, some the arrow keys, and their "blank
// screen" button sends B or a full stop. A pure function over plain values,
// so it is tested without a browser. See docs/adr/0015-presentation.md.

/** The parts of a KeyboardEvent this reads. */
export interface PlayerKey {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export type KeyAction =
  | "next"
  | "previous"
  /** Back to the stop shown last, after roaming. */
  | "back"
  | "first"
  | "last"
  /** A black screen, on and off. */
  | "blank"
  /** The list of stops and routes. */
  | "list"
  | "laser"
  /** Reduced motion, on and off. */
  | "motion"
  | "notes"
  | "fullscreen"
  | "zoom-in"
  | "zoom-out"
  /** Ends the presentation. */
  | "exit"
  /** A digit of a stop's number; Enter then jumps to it. */
  | { readonly digit: number };

const BY_KEY: { readonly [key: string]: KeyAction } = {
  ArrowRight: "next",
  ArrowDown: "next",
  PageDown: "next",
  " ": "next",
  Enter: "next",
  n: "next",
  ArrowLeft: "previous",
  ArrowUp: "previous",
  PageUp: "previous",
  p: "previous",
  Backspace: "back",
  r: "back",
  Home: "first",
  End: "last",
  b: "blank",
  ".": "blank",
  g: "list",
  l: "laser",
  m: "motion",
  s: "notes",
  f: "fullscreen",
  "+": "zoom-in",
  "=": "zoom-in",
  "-": "zoom-out",
  Escape: "exit",
};

/**
 * What a key press asks for, or null if it is not the player's. Keys with
 * Ctrl, Alt or Cmd are the browser's and the system's. A letter is read by
 * the character it gives, or, on a keyboard without Latin letters, by its
 * place on the keyboard.
 */
export function keyAction(input: PlayerKey): KeyAction | null {
  if (input.ctrlKey || input.altKey || input.metaKey) return null;
  let key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (key >= "0" && key <= "9" && key.length === 1) return { digit: Number(key) };
  if (key.length === 1 && !/[a-z .+=-]/.test(key) && /^Key[A-Z]$/.test(input.code))
    key = input.code.slice(3).toLowerCase();
  if (key === " " && input.shiftKey) return "previous";
  return Object.hasOwn(BY_KEY, key) ? BY_KEY[key]! : null;
}
