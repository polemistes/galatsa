// SPDX-License-Identifier: GPL-3.0-or-later

// From key presses to shortcuts on Windows/Linux and macOS, with US and
// Norwegian keyboards, AltGr included.

import { describe, expect, it } from "vitest";
import {
  isClipboardKey,
  matchShortcut,
  platformShortcut,
  shortcutCandidates,
  type KeyInput,
} from "./keymap.ts";

const PC = { mac: false };
const MAC = { mac: true };

function press(key: string, code: string, mods: Partial<KeyInput> = {}): KeyInput {
  return {
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    altGraph: false,
    ...mods,
  };
}

describe("shortcut candidates", () => {
  it("names letters with Mod for Ctrl on Windows and Linux and for Cmd on macOS", () => {
    expect(shortcutCandidates(press("z", "KeyZ", { ctrlKey: true }), PC)).toEqual([
      "Mod+z",
    ]);
    expect(shortcutCandidates(press("z", "KeyZ", { metaKey: true }), MAC)).toEqual([
      "Mod+z",
    ]);
    expect(shortcutCandidates(press("z", "KeyZ", { ctrlKey: true }), MAC)).toEqual([
      "Ctrl+z",
    ]);
    expect(
      shortcutCandidates(press("Z", "KeyZ", { ctrlKey: true, shiftKey: true }), PC),
    ).toEqual(["Mod+Shift+z"]);
  });

  it("matches punctuation by place too, so Shift does not hide it", () => {
    // US keyboard: Shift+] gives "}".
    expect(
      shortcutCandidates(
        press("}", "BracketRight", { ctrlKey: true, shiftKey: true }),
        PC,
      ),
    ).toEqual(["Mod+Shift+}", "Mod+Shift+]"]);
  });

  it("leaves AltGr out of the shortcut", () => {
    // Linux, Norwegian keyboard: Ctrl+AltGr+8 gives "[" with AltGraph set.
    const linux = press("[", "Digit8", { ctrlKey: true, altGraph: true });
    expect(shortcutCandidates(linux, PC)[0]).toBe("Mod+[");
    // Windows reports AltGr as Ctrl and Alt: AltGr+8 alone is no Mod shortcut.
    const windows = press("[", "Digit8", { ctrlKey: true, altKey: true, altGraph: true });
    expect(shortcutCandidates(windows, PC)[0]).toBe("[");
  });

  it("reaches Mod+[ on a Norwegian keyboard with Ctrl and the key right of P", () => {
    const map = new Map([[platformShortcut("Mod+[", PC)!, "send-backward"]]);
    expect(matchShortcut(press("å", "BracketLeft", { ctrlKey: true }), PC, map)).toEqual({
      shortcut: "Mod+[",
      value: "send-backward",
    });
  });

  it("does not match letters by place, except with Option on macOS", () => {
    // French keyboard: the key marked Z is where W is on a US keyboard.
    expect(shortcutCandidates(press("z", "KeyW", { ctrlKey: true }), PC)).toEqual([
      "Mod+z",
    ]);
    expect(
      shortcutCandidates(press("Ω", "KeyZ", { metaKey: true, altKey: true }), MAC),
    ).toEqual(["Mod+Alt+ω", "Mod+Alt+z"]);
  });

  it("names nothing for a modifier alone or a dead key", () => {
    expect(
      shortcutCandidates(press("Control", "ControlLeft", { ctrlKey: true }), PC),
    ).toEqual([]);
    expect(shortcutCandidates(press("Dead", "BracketRight"), PC)).toEqual([]);
  });

  it("names plain keys and Space", () => {
    expect(shortcutCandidates(press("Delete", "Delete"), PC)).toEqual(["Delete"]);
    expect(shortcutCandidates(press(" ", "Space"), PC)).toEqual(["Space"]);
    expect(shortcutCandidates(press("r", "KeyR"), PC)).toEqual(["r"]);
  });
});

describe("clipboard keys", () => {
  it("leaves Mod+C, Mod+X and Mod+V to the browser, on every layout", () => {
    expect(isClipboardKey(press("c", "KeyC", { ctrlKey: true }), PC)).toBe(true);
    expect(
      isClipboardKey(press("X", "KeyX", { ctrlKey: true, shiftKey: true }), PC),
    ).toBe(true);
    expect(isClipboardKey(press("v", "KeyV", { metaKey: true }), MAC)).toBe(true);
    // A Russian keyboard: the key marked V gives "м".
    expect(isClipboardKey(press("м", "KeyV", { ctrlKey: true }), PC)).toBe(true);
    // Not: Ctrl+C on macOS, plain C, Ctrl+Alt+C, Ctrl+D.
    expect(isClipboardKey(press("c", "KeyC", { ctrlKey: true }), MAC)).toBe(false);
    expect(isClipboardKey(press("c", "KeyC"), PC)).toBe(false);
    expect(isClipboardKey(press("c", "KeyC", { ctrlKey: true, altKey: true }), PC)).toBe(
      false,
    );
    expect(isClipboardKey(press("d", "KeyD", { ctrlKey: true }), PC)).toBe(false);
  });
});

describe("platform shortcuts", () => {
  it("spells Ctrl as Mod on Windows and Linux, and keeps it on macOS", () => {
    expect(platformShortcut("Ctrl+Shift+Z", PC)).toBe("Mod+Shift+z");
    expect(platformShortcut("Ctrl+Mod+Z", PC)).toBe("Mod+z");
    expect(platformShortcut("Ctrl+Z", MAC)).toBe("Ctrl+z");
    expect(platformShortcut("Mod++", PC)).toBe("Mod++");
    expect(platformShortcut("Bogus+Z", PC)).toBeUndefined();
  });
});
