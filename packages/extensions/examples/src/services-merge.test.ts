// SPDX-License-Identifier: GPL-3.0-or-later

// The editor's services and custom panel views are open to declaration merging:
// the editor (or its React binding) adds members, and code that uses them is
// type-checked. Here a test adds an optional service, as the editor would add a
// guides service.

import type { CustomPanelViews, EditorServices } from "@galatsa/extension-api/editing";
import { describe, expect, it } from "vitest";

declare module "@galatsa/extension-api/editing" {
  interface EditorServices {
    readonly testGuides?: { readonly count: () => number };
  }
  interface CustomPanelViews {
    readonly testBinding?: { readonly render: () => string };
  }
}

describe("declaration merging", () => {
  it("adds members to the editor services and the custom panel views", () => {
    const guides: EditorServices["testGuides"] = { count: () => 2 };
    const view: CustomPanelViews["testBinding"] = { render: () => "ok" };
    expect(guides?.count()).toBe(2);
    expect(view?.render()).toBe("ok");
  });
});
