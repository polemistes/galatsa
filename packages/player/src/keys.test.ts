// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { isReloadKey, keyAction, type PlayerKey } from "./keys.ts";
import { elapsedDigits } from "./notes.ts";

function key(name: string, more: Partial<PlayerKey> = {}): PlayerKey {
  return {
    key: name,
    code: "",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...more,
  };
}

describe("keys of a presentation", () => {
  it("reads what clickers send: PageDown and PageUp, the arrows, B and the full stop", () => {
    for (const name of ["PageDown", "ArrowRight", "ArrowDown", " ", "Enter", "n", "N"])
      expect(keyAction(key(name))).toBe("next");
    for (const name of ["PageUp", "ArrowLeft", "ArrowUp", "p"])
      expect(keyAction(key(name))).toBe("previous");
    expect(keyAction(key("b"))).toBe("blank");
    expect(keyAction(key("B", { shiftKey: true }))).toBe("blank");
    expect(keyAction(key("."))).toBe("blank");
  });

  it("has one key back to the stop, and keys for the rest", () => {
    expect(keyAction(key("Backspace"))).toBe("back");
    expect(keyAction(key("r"))).toBe("back");
    expect(keyAction(key("Home"))).toBe("first");
    expect(keyAction(key("End"))).toBe("last");
    expect(keyAction(key("g"))).toBe("list");
    expect(keyAction(key("l"))).toBe("laser");
    expect(keyAction(key("m"))).toBe("motion");
    expect(keyAction(key("s"))).toBe("notes");
    expect(keyAction(key("f"))).toBe("fullscreen");
    expect(keyAction(key("+"))).toBe("zoom-in");
    expect(keyAction(key("-"))).toBe("zoom-out");
    expect(keyAction(key("Escape"))).toBe("exit");
    expect(keyAction(key(" ", { shiftKey: true }))).toBe("previous");
    expect(keyAction(key("7"))).toEqual({ digit: 7 });
  });

  it("leaves keys with Ctrl, Alt or Cmd to the browser, and other keys alone", () => {
    expect(keyAction(key("f", { ctrlKey: true }))).toBe(null);
    expect(keyAction(key("ArrowLeft", { altKey: true }))).toBe(null);
    expect(keyAction(key("r", { metaKey: true }))).toBe(null);
    expect(keyAction(key("x"))).toBe(null);
    expect(keyAction(key("F5"))).toBe(null);
    expect(keyAction(key("Tab"))).toBe(null);
    expect(keyAction(key("constructor"))).toBe(null);
  });

  it("reads a letter by its place on a keyboard without Latin letters", () => {
    expect(keyAction(key("и", { code: "KeyB" }))).toBe("blank");
    expect(keyAction(key("λ", { code: "KeyL" }))).toBe("laser");
    // A Latin letter counts as itself, wherever its key is.
    expect(keyAction(key("b", { code: "KeyN" }))).toBe("blank");
  });
});

describe("keys that reload the page", () => {
  it("are F5 with or without modifiers, Ctrl+R and Cmd+R, and the reload key", () => {
    expect(isReloadKey(key("F5", { code: "F5" }))).toBe(true);
    expect(isReloadKey(key("F5", { code: "F5", shiftKey: true }))).toBe(true);
    expect(isReloadKey(key("F5", { code: "F5", ctrlKey: true }))).toBe(true);
    expect(isReloadKey(key("r", { code: "KeyR", ctrlKey: true }))).toBe(true);
    expect(isReloadKey(key("R", { code: "KeyR", ctrlKey: true, shiftKey: true }))).toBe(
      true,
    );
    expect(isReloadKey(key("r", { code: "KeyR", metaKey: true }))).toBe(true);
    // A keyboard without Latin letters: by the key's place.
    expect(isReloadKey(key("к", { code: "KeyR", ctrlKey: true }))).toBe(true);
    expect(isReloadKey(key("BrowserRefresh"))).toBe(true);
  });

  it("are not R alone, Alt+R, or the presentation's keys", () => {
    expect(isReloadKey(key("r", { code: "KeyR" }))).toBe(false);
    expect(isReloadKey(key("r", { code: "KeyR", altKey: true, ctrlKey: true }))).toBe(
      false,
    );
    expect(isReloadKey(key("PageDown"))).toBe(false);
    expect(isReloadKey(key("Escape"))).toBe(false);
  });
});

describe("the time used", () => {
  it("is shown in minutes and seconds, with hours past the first", () => {
    expect(elapsedDigits(0)).toBe("00:00");
    expect(elapsedDigits(65_999)).toBe("01:05");
    expect(elapsedDigits(3_725_000)).toBe("1:02:05");
    expect(elapsedDigits(-5)).toBe("00:00");
  });
});
