// SPDX-License-Identifier: GPL-3.0-or-later

// From a key press to a shortcut ("Mod+Shift+Z"), as the command registry and
// the tools spell them (docs/adr/0005, section 2). Pure functions over plain
// values, so they are tested without a browser.
//
// A key press can name a shortcut in more than one way, and the candidates are
// tried in order:
//
// 1. By the character the key gives (`KeyboardEvent.key`), with the modifiers.
//    AltGr is not a modifier of the shortcut, and is never read as Ctrl+Alt:
//    where the system reports it as AltGraph, Alt is left out, and on Windows,
//    which reports AltGr as Ctrl and Alt together, both are (see isAltGr). So
//    "Mod+[" on a Norwegian keyboard is Ctrl+AltGr+8 where the system tells
//    Ctrl and AltGr apart (Linux; macOS has no AltGr), as the character [
//    suggests.
// 2. By the key's place on the keyboard (`KeyboardEvent.code`), named as on a
//    US keyboard, for punctuation and digits only, and only where the
//    character cannot name the shortcut: where the key gives a letter on this
//    layout, or Shift changed the character. So Mod+Shift+] works on a US
//    keyboard, where Shift+] gives "}", and Mod+[ is reachable as Ctrl and the
//    key right of P (Å on a Norwegian keyboard). A character of its own wins:
//    Ctrl and + on a Norwegian keyboard is Mod++, never the Mod+- of that
//    key's place on a US keyboard, and a character AltGr gave ({ on AltGr+7)
//    never falls back to the digit. A dead key with Mod (¨ right of Å on a
//    Norwegian keyboard) is matched by place, so Mod+] is Ctrl and that key.
//    Letters are not matched by place: Ctrl+Z
//    on a French keyboard is the key marked Z, not the one where Z is on a US
//    keyboard.
// 3. On macOS with Option, by place for letters too, because Option changes the
//    character a letter key gives (Option+Z gives "Ω").
//
// Shortcut conflicts across keyboard layouts (two shortcuts that one layout
// gives with the same keys) are the editor shell's later work.

import { normalizeShortcut, type Shortcut } from "@galatsa/extension-api";

/** The parts of a KeyboardEvent the keymap reads. */
export interface KeyInput {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  /** `getModifierState("AltGraph")`. */
  readonly altGraph: boolean;
}

export interface Platform {
  /** macOS (and iOS): Mod is Cmd. Elsewhere Mod is Ctrl. */
  readonly mac: boolean;
}

/** Keys that are modifiers themselves; pressing one alone names no shortcut. */
const MODIFIER_KEYS = new Set([
  "Control",
  "Alt",
  "AltGraph",
  "Shift",
  "Meta",
  "OS",
  "Hyper",
  "Super",
  "CapsLock",
  "Fn",
]);

/** Punctuation and digit keys by place, as named on a US keyboard. */
const US_KEYS: { readonly [code: string]: string } = {
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Backquote: "`",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
};

/** The platform the program runs on, from the browser. */
export function detectPlatform(): Platform {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } })
    .navigator;
  const name = nav?.platform ?? nav?.userAgent ?? "";
  return { mac: /Mac|iPhone|iPad|iPod/i.test(name) };
}

/**
 * A shortcut as the platform's keyboard map stores it: canonical, and on
 * Windows and Linux with Ctrl spelled Mod (they are the same key there).
 */
export function platformShortcut(
  shortcut: string,
  platform: Platform,
): Shortcut | undefined {
  const normal = normalizeShortcut(shortcut);
  if (normal === undefined || platform.mac) return normal;
  const parts = normal.split("+");
  if (normal.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => (p === "Ctrl" ? "Mod" : p)));
  return normalizeShortcut([...mods, key].join("+"));
}

function spell(
  mods: { mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean },
  key: string,
): Shortcut | undefined {
  const parts: string[] = [];
  if (mods.mod) parts.push("Mod");
  if (mods.ctrl) parts.push("Ctrl");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  if (mods.meta) parts.push("Meta");
  parts.push(key);
  return normalizeShortcut(parts.join("+"));
}

/** The shortcuts a key press may stand for, most likely first. */
export function shortcutCandidates(input: KeyInput, platform: Platform): Shortcut[] {
  if (MODIFIER_KEYS.has(input.key) || input.key === "Unidentified") return [];
  const altGr = isAltGr(input, platform);
  // What AltGr adds is not a modifier of the shortcut: on Windows it comes as
  // Ctrl and Alt together, elsewhere as AltGraph alone.
  const alt = input.altKey && !altGr;
  const ctrl = input.ctrlKey && !(altGr && input.altKey);
  const mods = {
    mod: platform.mac ? input.metaKey : ctrl,
    ctrl: platform.mac ? input.ctrlKey : false,
    alt,
    shift: input.shiftKey,
    meta: platform.mac ? false : input.metaKey,
  };
  const out: Shortcut[] = [];
  const add = (s: Shortcut | undefined): void => {
    if (s !== undefined && !out.includes(s)) out.push(s);
  };
  // A dead key gives no character. With Mod it names its place, as on a US
  // keyboard: Ctrl and the key right of Å on a Norwegian keyboard (¨, a dead
  // key) is Mod+], as Ctrl and Å is Mod+[. Alone, or with AltGr, it names
  // nothing: it is the start of a character being typed.
  if (input.key === "Dead") {
    const us = US_KEYS[input.code];
    if (us !== undefined && mods.mod && !altGr) add(spell(mods, us));
    return out;
  }
  // 1. By character. Space is named "Space" rather than " ".
  const key = input.key === " " ? "Space" : input.key;
  add(spell(mods, key));
  // 2. By place, punctuation and digits, as on a US keyboard: only where the
  //    character cannot name the shortcut itself. That is where the key gives
  //    a letter on this layout (Å right of P on a Norwegian keyboard), or where
  //    Shift changed the character (Shift+] gives "}" on a US keyboard). Not
  //    for a character AltGr gave ({ or @ on a digit key), and not for a
  //    character of its own (Ctrl and + on a Norwegian keyboard is Mod++, not
  //    the Mod+- of the key's place on a US keyboard).
  const us = US_KEYS[input.code];
  if (us !== undefined && !altGr && (isLetter(input.key) || input.shiftKey))
    add(spell(mods, us));
  // 3. macOS with Option: letters by place.
  if (platform.mac && input.altKey && /^Key[A-Z]$/.test(input.code))
    add(spell(mods, input.code.slice(3).toLowerCase()));
  return out;
}

/** A letter of any script (å, я), not punctuation, a digit or a symbol. */
function isLetter(key: string): boolean {
  return [...key].length === 1 && /\p{L}/u.test(key);
}

/**
 * Whether AltGr made this key press's character, on Windows and Linux.
 * Browsers report AltGr as AltGraph, and on Windows also as Ctrl and Alt
 * together; some report only Ctrl and Alt. A press with Ctrl and Alt counts as
 * AltGr when it gave a character that is not a letter or a digit ({, @, €),
 * and as a real Ctrl+Alt when it gave a plain letter or digit (AltGr would have
 * given another character, or none).
 */
function isAltGr(input: KeyInput, platform: Platform): boolean {
  if (platform.mac) return false;
  const single = [...input.key].length === 1;
  const plain = single && /^[\p{L}\p{N}]$/u.test(input.key);
  // A dead key with Ctrl and Alt is AltGr starting a character on Windows
  // (¨ or ~ with AltGr); it gives no character to tell by.
  if (input.ctrlKey && input.altKey) return input.key === "Dead" || (single && !plain);
  return input.altGraph;
}

/** The first of a key press's candidates that `map` has, with what it maps to. */
export function matchShortcut<T>(
  input: KeyInput,
  platform: Platform,
  map: ReadonlyMap<Shortcut, T>,
): { shortcut: Shortcut; value: T } | undefined {
  for (const shortcut of shortcutCandidates(input, platform)) {
    const value = map.get(shortcut);
    if (value !== undefined) return { shortcut, value };
  }
  return undefined;
}

/**
 * Mod+C, Mod+X or Mod+V (by character, or by place for layouts without Latin
 * letters): left to the browser, which turns them into copy, cut and paste
 * events.
 */
export function isClipboardKey(input: KeyInput, platform: Platform): boolean {
  const mod = platform.mac ? input.metaKey : input.ctrlKey;
  if (!mod || input.altKey || input.altGraph) return false;
  const letter = /^[a-z]$/i.test(input.key)
    ? input.key.toLowerCase()
    : /^Key[A-Z]$/.test(input.code)
      ? input.code.slice(3).toLowerCase()
      : "";
  return letter === "c" || letter === "x" || letter === "v";
}

/** A KeyInput from a DOM keyboard event. */
export function keyInput(event: KeyboardEvent): KeyInput {
  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    altGraph:
      typeof event.getModifierState === "function" && event.getModifierState("AltGraph"),
  };
}
