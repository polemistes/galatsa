// SPDX-License-Identifier: GPL-3.0-or-later

// The extension host: checking manifests, dependency order, problems, unloading.

import { defineMessages, type MessageBundle } from "@galatsa/i18n";
import { describe, expect, it } from "vitest";
import type { Extension } from "./extension.ts";
import { ExtensionHost, problemMessage } from "./host.ts";
import { EXTENSION_API_VERSION, type ExtensionId } from "./ids.ts";

function ext(
  id: ExtensionId,
  more: Partial<Omit<Extension, "id">> = {},
  log?: string[],
): Extension {
  return {
    id,
    version: "1.0.0",
    api: EXTENSION_API_VERSION,
    activate: () => log?.push(`+${id}`),
    deactivate: () => log?.push(`-${id}`),
    ...more,
  };
}

function registry() {
  const registered: string[] = [];
  return {
    registered,
    // Like I18n: registering a namespace again replaces it.
    register: (b: MessageBundle) => {
      if (!registered.includes(b.namespace)) registered.push(b.namespace);
    },
    unregister: (ns: string) => {
      if (registered.includes(ns)) registered.splice(registered.indexOf(ns), 1);
    },
  };
}

describe("loading", () => {
  it("activates in dependency order, keeping the given order otherwise", () => {
    const log: string[] = [];
    const host = new ExtensionHost();
    const problems = host.load([
      ext("c", { dependencies: [{ id: "b" }] }, log),
      ext("a", {}, log),
      ext("b", { dependencies: [{ id: "a" }] }, log),
      ext("d", {}, log),
    ]);
    expect(problems).toEqual([]);
    expect(log).toEqual(["+a", "+b", "+c", "+d"]);
    expect(host.active()).toEqual(["a", "b", "c", "d"]);
  });

  it("reports missing and failed dependencies and cycles, and loads the rest", () => {
    const log: string[] = [];
    const host = new ExtensionHost();
    const problems = host.load([
      ext("needs.missing", { dependencies: [{ id: "nowhere" }] }, log),
      ext("needs.needs", { dependencies: [{ id: "needs.missing" }] }, log),
      ext("loop.a", { dependencies: [{ id: "loop.b" }] }, log),
      ext("loop.b", { dependencies: [{ id: "loop.a" }] }, log),
      ext("fine", { dependencies: [{ id: "nowhere", optional: true }] }, log),
    ]);
    expect(problems.map((p) => [p.extension, p.code, p.dependency])).toEqual([
      ["needs.missing", "missing-dependency", "nowhere"],
      ["needs.needs", "dependency-failed", "needs.missing"],
      ["loop.a", "cycle", undefined],
      ["loop.b", "cycle", undefined],
    ]);
    expect(log).toEqual(["+fine"]);
    expect(host.problems).toEqual(problems);
  });

  it("waits for an optional dependency that is being loaded", () => {
    const log: string[] = [];
    const host = new ExtensionHost();
    host.load([
      ext("user", { dependencies: [{ id: "lib", optional: true }] }, log),
      ext("lib", {}, log),
    ]);
    expect(log).toEqual(["+lib", "+user"]);
  });

  it("satisfies a dependency from an earlier load", () => {
    const host = new ExtensionHost();
    host.load([ext("base")]);
    expect(host.load([ext("addon", { dependencies: [{ id: "base" }] })])).toEqual([]);
    expect(host.load([ext("base")]).map((p) => p.code)).toEqual(["duplicate"]);
  });

  it("refuses another interface major version or a newer minor version", () => {
    const host = new ExtensionHost({ apiVersion: { major: 1, minor: 2 } });
    const problems = host.load([
      ext("old.major", { api: { major: 0, minor: 9 } }),
      ext("new.minor", { api: { major: 1, minor: 3 } }),
      ext("ok", { api: { major: 1, minor: 1 } }),
    ]);
    expect(problems.map((p) => [p.extension, p.code])).toEqual([
      ["old.major", "api-version"],
      ["new.minor", "api-version"],
    ]);
    expect(host.active()).toEqual(["ok"]);
  });

  it("checks ids, names, labels and message namespaces before activating", () => {
    const messages = defineMessages("good", {
      nb: { name: "Navn" },
      en: { name: "Name" },
    });
    const command = (label: string) => ({
      name: "cmd",
      label: label as `${string}:${string}`,
      execute: () => {},
    });
    const host = new ExtensionHost();
    const problems = host.load([
      ext("Bad_Id"),
      ext("good.one", {
        messages: [messages],
        contributes: { commands: [command("good:name")] },
      }),
      ext("good.two", {
        messages: [messages],
        contributes: { commands: [command("good:typo")] },
      }),
      ext("other", { messages: [messages] }),
      ext("borrow", { contributes: { commands: [command("good:name")] } }),
      ext("common.user", { contributes: { commands: [command("common:action.ok")] } }),
      ext("twice", {
        contributes: { commands: [command("common:a"), command("common:b")] },
      }),
      ext("versions", {
        contributes: {
          elementTypes: [
            {
              name: "t",
              label: "common:x",
              typeVersion: 2,
              read: () => null,
              draw: () => {},
            },
          ],
        },
      }),
    ]);
    expect(problems.map((p) => [p.extension, p.code])).toEqual([
      ["Bad_Id", "invalid"],
      ["good.two", "invalid"],
      ["other", "invalid"],
      ["borrow", "invalid"],
      ["twice", "invalid"],
      ["versions", "invalid"],
    ]);
    expect(problems.find((p) => p.extension === "good.two")!.detail).toContain(
      "good:typo",
    );
    expect(host.active()).toEqual(["good.one", "common.user"]);
  });

  it("leaves out an extension whose activation throws, with its contributions and dependents", () => {
    const host = new ExtensionHost();
    const problems = host.load([
      ext("broken", {
        activate: () => {
          throw new Error("no luck");
        },
        contributes: { commands: [{ name: "x", label: "common:x", execute: () => {} }] },
      }),
      ext("after", { dependencies: [{ id: "broken" }] }),
    ]);
    expect(problems.map((p) => [p.extension, p.code, p.detail])).toEqual([
      ["broken", "activate-failed", "no luck"],
      ["after", "dependency-failed", "needs broken"],
    ]);
    expect(host.commands.get("broken/x")).toBeUndefined();
  });

  it("has a user-facing message for every problem", () => {
    const message = problemMessage({
      extension: "a",
      code: "missing-dependency",
      dependency: "b",
      detail: "",
    });
    expect(message).toEqual({
      label: "extensions:problem.missing-dependency",
      values: { extension: "a", dependency: "b" },
    });
  });
});

describe("unloading", () => {
  it("unloads dependents first, removes contributions and shared messages last", () => {
    const log: string[] = [];
    const i18n = registry();
    const shared = defineMessages("pack", { nb: { x: "X" }, en: { x: "X" } });
    const host = new ExtensionHost({ i18n });
    host.load([
      ext("pack.base", { messages: [shared] }, log),
      ext(
        "pack.addon",
        {
          messages: [shared],
          dependencies: [{ id: "pack.base" }],
          contributes: { commands: [{ name: "go", label: "pack:x", execute: () => {} }] },
        },
        log,
      ),
      ext("other", {}, log),
    ]);
    expect(i18n.registered).toEqual(["extensions", "pack"]);
    expect(host.unload("pack.base")).toEqual(["pack.addon", "pack.base"]);
    expect(log).toEqual([
      "+pack.base",
      "+pack.addon",
      "+other",
      "-pack.addon",
      "-pack.base",
    ]);
    expect(host.commands.get("pack.addon/go")).toBeUndefined();
    expect(i18n.registered).toEqual(["extensions"]);
    expect(host.active()).toEqual(["other"]);
    expect(host.unload("pack.base")).toEqual([]);
  });
});
