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
    expect(
      shortcutCandidates(press("Dead", "BracketRight", { shiftKey: true }), PC),
    ).toEqual([]);
    // With AltGr it starts a character too.
    expect(
      shortcutCandidates(
        press("Dead", "BracketRight", { ctrlKey: true, altGraph: true }),
        PC,
      ),
    ).toEqual([]);
  });

  it("reaches the stacking shortcuts on a Norwegian keyboard, by place and by AltGr", () => {
    const map = new Map(
      [
        ["Mod+[", "send-backward"],
        ["Mod+]", "bring-forward"],
        ["Mod+Shift+[", "send-to-back"],
        ["Mod+Shift+]", "bring-to-front"],
        ["Mod+ArrowUp", "bring-forward"],
        ["Mod+Shift+ArrowDown", "send-to-back"],
      ].map(([s, v]) => [platformShortcut(s!, PC)!, v!]),
    );
    const value = (input: KeyInput) => matchShortcut(input, PC, map)?.value;
    // Ctrl and the two keys right of P: Å, and ¨ (a dead key).
    expect(value(press("å", "BracketLeft", { ctrlKey: true }))).toBe("send-backward");
    expect(value(press("Dead", "BracketRight", { ctrlKey: true }))).toBe("bring-forward");
    expect(value(press("Å", "BracketLeft", { ctrlKey: true, shiftKey: true }))).toBe(
      "send-to-back",
    );
    expect(value(press("Dead", "BracketRight", { ctrlKey: true, shiftKey: true }))).toBe(
      "bring-to-front",
    );
    // Linux: Ctrl+AltGr+8 and Ctrl+AltGr+9 give the brackets themselves.
    expect(value(press("[", "Digit8", { ctrlKey: true, altGraph: true }))).toBe(
      "send-backward",
    );
    expect(value(press("]", "Digit9", { ctrlKey: true, altGraph: true }))).toBe(
      "bring-forward",
    );
    // The arrow keys, on every layout.
    expect(value(press("ArrowUp", "ArrowUp", { ctrlKey: true }))).toBe("bring-forward");
    expect(
      value(press("ArrowDown", "ArrowDown", { ctrlKey: true, shiftKey: true })),
    ).toBe("send-to-back");
    // macOS: Cmd and the key right of Å (dead there too).
    expect(
      matchShortcut(press("Dead", "BracketRight", { metaKey: true }), MAC, map)?.value,
    ).toBe("bring-forward");
  });

  it("names plain keys and Space", () => {
    expect(shortcutCandidates(press("Delete", "Delete"), PC)).toEqual(["Delete"]);
    expect(shortcutCandidates(press(" ", "Space"), PC)).toEqual(["Space"]);
    expect(shortcutCandidates(press("r", "KeyR"), PC)).toEqual(["r"]);
  });
});

describe("by-place fallbacks and AltGr (the review's cases)", () => {
  const cases: Array<[string, KeyInput, typeof PC, string[]]> = [
    // AltGr on Windows (Ctrl, Alt and AltGraph): the character alone.
    [
      "Win nb AltGr+8 [",
      press("[", "Digit8", { ctrlKey: true, altKey: true, altGraph: true }),
      PC,
      ["["],
    ],
    [
      "Win nb AltGr+2 @",
      press("@", "Digit2", { ctrlKey: true, altKey: true, altGraph: true }),
      PC,
      ["@"],
    ],
    [
      "Win nb AltGr+E €",
      press("€", "KeyE", { ctrlKey: true, altKey: true, altGraph: true }),
      PC,
      ["€"],
    ],
    // Some browsers report AltGr as Ctrl and Alt only.
    [
      "Win nb AltGr+7 { without AltGraph",
      press("{", "Digit7", { ctrlKey: true, altKey: true }),
      PC,
      ["{"],
    ],
    // AltGr on Linux (AltGraph only): never the digit's place.
    ["Linux nb AltGr+7 {", press("{", "Digit7", { altGraph: true }), PC, ["{"]],
    ["Linux nb AltGr+8 [", press("[", "Digit8", { altGraph: true }), PC, ["["]],
    [
      "Linux nb Ctrl+AltGr+8 [",
      press("[", "Digit8", { ctrlKey: true, altGraph: true }),
      PC,
      ["Mod+["],
    ],
    // A character of its own wins over the key's place.
    [
      "Linux nb Ctrl++ (Minus key)",
      press("+", "Minus", { ctrlKey: true }),
      PC,
      ["Mod++"],
    ],
    [
      "Linux nb Ctrl+- (Slash key)",
      press("-", "Slash", { ctrlKey: true }),
      PC,
      ["Mod+-"],
    ],
    // Shift changed the character: the place too.
    [
      "Linux nb Shift+7 /",
      press("/", "Digit7", { shiftKey: true }),
      PC,
      ["Shift+/", "Shift+7"],
    ],
    [
      "Linux nb Ctrl+Shift+0 =",
      press("=", "Digit0", { ctrlKey: true, shiftKey: true }),
      PC,
      ["Mod+Shift+=", "Mod+Shift+0"],
    ],
    // A real Ctrl+Alt on Windows (which also reports AltGraph) gives the plain letter.
    [
      "Win Ctrl+Alt+Z",
      press("z", "KeyZ", { ctrlKey: true, altKey: true, altGraph: true }),
      PC,
      ["Mod+Alt+z"],
    ],
    [
      "Linux Ctrl+Alt+Z",
      press("z", "KeyZ", { ctrlKey: true, altKey: true }),
      PC,
      ["Mod+Alt+z"],
    ],
    // macOS: Option is Alt; [ by Option+8 on a Norwegian keyboard is not the digit.
    ["Mac nb Option+8 [", press("[", "Digit8", { altKey: true }), MAC, ["Alt+["]],
    [
      "Mac nb Cmd+Option+8 [",
      press("[", "Digit8", { metaKey: true, altKey: true }),
      MAC,
      ["Mod+Alt+["],
    ],
    [
      "Mac Cmd+Shift+Z",
      press("z", "KeyZ", { metaKey: true, shiftKey: true }),
      MAC,
      ["Mod+Shift+z"],
    ],
  ];
  for (const [name, input, platform, expected] of cases) {
    it(name, () => {
      expect(shortcutCandidates(input, platform)).toEqual(expected);
    });
  }

  it("never reads AltGr as Ctrl+Alt in any candidate", () => {
    for (const [, input, platform] of cases.filter(([n]) => n.includes("AltGr"))) {
      for (const candidate of shortcutCandidates(input, platform)) {
        expect(candidate).not.toMatch(/Alt\+/);
        if (!input.ctrlKey || input.altKey) expect(candidate).not.toMatch(/Mod\+/);
      }
    }
  });

  it("does not let Ctrl++ on a Norwegian keyboard reach Mod+- (zoom out)", () => {
    const map = new Map([
      [platformShortcut("Mod+=", PC)!, "zoom-in"],
      [platformShortcut("Mod+-", PC)!, "zoom-out"],
    ]);
    expect(
      matchShortcut(press("+", "Minus", { ctrlKey: true }), PC, map),
    ).toBeUndefined();
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
