// SPDX-License-Identifier: GPL-3.0-or-later

// Presenting from the editor: the service extensions start a presentation
// with, the page's presenter behind it, and what the editor does when the
// presentation ends. The player itself is tested in @galatsa/player and, in a
// browser, in tests/e2e/presentation.spec.ts. See docs/adr/0015.

import type { PresentationRequest } from "@galatsa/extension-api/editing";
import { TRANSITIONS_EXTENSION_ID } from "@galatsa/extension-transitions";
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "./editor.ts";
import { testEditor } from "./test-support.ts";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
});

function setup() {
  const t = testEditor();
  editors.push(t.editor);
  const started: PresentationRequest[] = [];
  let exits = 0;
  let ended: (() => void) | null = null;
  const present = (): void =>
    t.editor.setPresenter((request, onEnded) => {
      started.push(request);
      ended = onEnded;
      return {
        exit() {
          exits++;
          onEnded();
        },
      };
    });
  return {
    ...t,
    started,
    present,
    end: () => ended?.(),
    exits: () => exits,
  };
}

describe("presenting from the editor", () => {
  it("does not start without a page to present on", () => {
    const t = setup();
    expect(t.editor.services.presentation.active()).toBe(false);
    expect(t.editor.services.presentation.start()).toBe(false);
    expect(t.editor.presenting).toBe(null);
  });

  it("starts through the service, once, and gives the keys back when it ends", () => {
    const t = setup();
    t.present();
    let focused = 0;
    t.editor.setCanvasFocus(() => focused++);
    expect(t.editor.services.presentation.start({ route: "r", step: 2 })).toBe(true);
    expect(t.started).toEqual([{ route: "r", step: 2 }]);
    expect(t.editor.services.presentation.active()).toBe(true);
    expect(t.editor.presenting).not.toBe(null);
    // One presentation at a time.
    expect(t.editor.services.presentation.start()).toBe(false);
    expect(t.started.length).toBe(1);
    t.end();
    expect(t.editor.services.presentation.active()).toBe(false);
    expect(t.editor.presenting).toBe(null);
    expect(focused).toBe(1);
    // And again.
    expect(t.editor.present()).toBe(true);
    expect(t.started).toEqual([{ route: "r", step: 2 }, {}]);
  });

  it("is not running when the presenter could not start", () => {
    const t = setup();
    t.editor.setPresenter(() => null);
    expect(t.editor.services.presentation.start()).toBe(false);
    expect(t.editor.services.presentation.active()).toBe(false);
  });

  it("is not running when the presentation ended while it started, and is told only once", () => {
    const t = setup();
    let focused = 0;
    t.editor.setCanvasFocus(() => focused++);
    t.editor.setPresenter((_request, ended) => {
      ended();
      ended();
      return { exit: () => ended() };
    });
    expect(t.editor.present()).toBe(false);
    expect(t.editor.presenting).toBe(null);
    expect(focused).toBe(1);
  });

  it("ends the presentation when the editor goes away", () => {
    const t = setup();
    t.present();
    t.editor.present();
    t.editor.dispose();
    expect(t.exits()).toBe(1);
    expect(t.editor.present()).toBe(false);
  });

  it("has the built-in transitions, so a presentation plays what the stops ask for", () => {
    const t = setup();
    for (const name of ["fly", "fade", "cut"])
      expect(
        t.editor.host.transition(`${TRANSITIONS_EXTENSION_ID}/${name}`),
      ).toBeDefined();
  });
});
