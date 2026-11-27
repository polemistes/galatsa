// SPDX-License-Identifier: GPL-3.0-or-later

// The viewing host: loads the viewing parts of extensions in dependency order,
// checks them, activates them, and offers element types and transitions to the
// renderer and the player. The editor's host (editor-host.ts) extends it with
// the editing parts. Nothing here needs Yjs. See
// docs/adr/0005-extension-interface.md, section 9.

import {
  FRAME_TYPE,
  GROUP_TYPE,
  type ElementData,
  type ElementId,
  type Size,
} from "@galatsa/core";
import type { MessageBundle, MessageValues } from "@galatsa/i18n";
import type { DrawContext } from "./draw.ts";
import type { AnyElementView } from "./element-type.ts";
import type {
  ActivationContext,
  ExtensionDependency,
  ViewExtension,
} from "./extension.ts";
import {
  CONTRIBUTION_NAME_PATTERN,
  EXTENSION_API_VERSION,
  EXTENSION_ID_PATTERN,
  availableIn,
  isApiCompatible,
  messageKey,
  type ApiVersion,
  type ContributionId,
  type ExtensionId,
  type Label,
  type Mode,
} from "./ids.ts";
import { extensionMessages } from "./messages/index.ts";
import { drawPlaceholder, type PlaceholderReason } from "./placeholder.ts";
import type { AnyTransition } from "./transition.ts";

/** Why an extension was not loaded. */
export type LoadProblemCode =
  | "invalid"
  | "duplicate"
  | "api-version"
  | "missing-dependency"
  | "dependency-failed"
  | "cycle"
  | "activate-failed";

export interface LoadProblem {
  readonly extension: ExtensionId;
  readonly code: LoadProblemCode;
  /** The dependency concerned, for dependency problems. */
  readonly dependency?: ExtensionId;
  /** Technical detail for developers, in English; not shown to users. */
  readonly detail: string;
}

/** A user-facing message for a load problem. */
export function problemMessage(problem: LoadProblem): {
  readonly label: Label;
  readonly values: MessageValues;
} {
  return {
    label: messageKey(extensionMessages, `problem.${problem.code}`),
    values: { extension: problem.extension, dependency: problem.dependency ?? "" },
  };
}

/** A contribution as the host offers it. */
export interface Registered<D> {
  readonly id: ContributionId;
  readonly extension: ExtensionId;
  readonly definition: D;
}

/** What the host knows about an element's type. */
export type ElementTypeResolution =
  | { readonly status: "known"; readonly type: Registered<AnyElementView> }
  | { readonly status: "core" }
  | {
      readonly status: "placeholder";
      readonly reason: Exclude<PlaceholderReason, "failed">;
    };

/** The facts of an element the host reads; every snapshot element has them. */
export interface ElementFacts {
  readonly type: string;
  readonly typeVersion: number;
}

/** The part of the program's I18n the host uses. */
export interface MessageRegistry {
  register(bundle: MessageBundle): void;
  unregister(namespace: string): void;
}

export interface HostOptions {
  /** Where the extensions' message bundles are registered. */
  readonly i18n?: MessageRegistry;
  /** The interface version this host implements (tests use others). */
  readonly apiVersion?: ApiVersion;
}

/**
 * One extension as the loader handles it: the viewing part, or the viewing and
 * editing parts together. Hosts build these from manifests.
 */
export interface LoadUnit {
  readonly id: ExtensionId;
  readonly api: ApiVersion;
  readonly dependencies: readonly ExtensionDependency[];
  readonly messages: readonly MessageBundle[];
  /** Contributions by kind, for the checks every kind shares. */
  readonly lists: ReadonlyArray<
    readonly [kind: string, items: readonly { readonly name: string }[]]
  >;
  /** Checks of its own; returns what is wrong. */
  check(): string | undefined;
  activate(context: ActivationContext): void;
  deactivate(): void;
  /** Offers the contributions; returns how to take each back. */
  offer(): Array<() => void>;
}

interface Loaded {
  readonly unit: LoadUnit;
  readonly undo: Array<() => void>;
}

/** True if `namespace` is `id` or a prefix of it made of whole words. */
export function ownsNamespace(id: ExtensionId, namespace: string): boolean {
  return id === namespace || id.startsWith(`${namespace}.`);
}

/** Every label in a contribution, wherever it is. */
function labelsIn(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) labelsIn(item, out, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      (key === "label" || key === "description" || key === "unit") &&
      typeof item === "string"
    )
      out.push(item);
    else labelsIn(item, out, depth + 1);
  }
}

/** The load unit of a viewing part. */
export function viewUnit(
  extension: ViewExtension,
  offer: () => Array<() => void>,
): LoadUnit {
  return {
    id: extension.id,
    api: extension.api,
    dependencies: extension.dependencies ?? [],
    messages: extension.messages ?? [],
    lists: [
      ["element type", extension.elementTypes ?? []],
      ["transition", extension.transitions ?? []],
    ],
    check: () => {
      for (const type of extension.elementTypes ?? []) {
        if (!Number.isInteger(type.typeVersion) || type.typeVersion < 1)
          return `element type ${type.name}: typeVersion must be an integer >= 1`;
      }
      return undefined;
    },
    activate: (context) => extension.activate?.(context),
    deactivate: () => extension.deactivate?.(),
    offer,
  };
}

/**
 * Loads extensions and offers their viewing contributions. Each extension is
 * checked as a whole; one that fails is reported and left out, with the
 * extensions that need it, and never stops the others.
 */
export class ViewHost {
  readonly apiVersion: ApiVersion;
  readonly #i18n: MessageRegistry | undefined;
  /** Active extensions, in activation order. */
  readonly #loaded = new Map<ExtensionId, Loaded>();
  readonly #problems: LoadProblem[] = [];
  readonly #elementTypes = new Map<string, Registered<AnyElementView>>();
  readonly #transitions = new Map<ContributionId, Registered<AnyTransition>>();

  constructor(options: HostOptions = {}) {
    this.apiVersion = options.apiVersion ?? EXTENSION_API_VERSION;
    this.#i18n = options.i18n;
    this.#i18n?.register(extensionMessages);
  }

  /** Problems from every load so far. */
  get problems(): readonly LoadProblem[] {
    return this.#problems;
  }

  isActive(id: ExtensionId): boolean {
    return this.#loaded.has(id);
  }

  /** Active extensions, in activation order. */
  active(): ExtensionId[] {
    return [...this.#loaded.keys()];
  }

  /**
   * Loads the viewing parts of extensions: checks them, orders them by their
   * dependencies (keeping the given order otherwise) and activates them.
   * Extensions loaded earlier stay. Returns the problems of this load.
   */
  load(extensions: readonly ViewExtension[]): LoadProblem[] {
    return this.loadUnits(extensions.map((e) => viewUnit(e, () => this.offerView(e))));
  }

  /** Offers the viewing contributions of an extension; returns how to take them back. */
  protected offerView(extension: ViewExtension): Array<() => void> {
    const undo: Array<() => void> = [];
    const offer = <D extends { readonly name: string }>(
      map: Map<string, Registered<D>>,
      list: readonly D[] | undefined,
    ): void => {
      for (const definition of list ?? []) {
        const key = `${extension.id}/${definition.name}`;
        map.set(key, { id: key, extension: extension.id, definition });
        undo.push(() => map.delete(key));
      }
    };
    offer(this.#elementTypes, extension.elementTypes);
    offer(this.#transitions, extension.transitions);
    return undo;
  }

  /** The shared loader: checks, orders and activates units. */
  protected loadUnits(units: readonly LoadUnit[]): LoadProblem[] {
    const problems: LoadProblem[] = [];
    const report = (
      extension: ExtensionId,
      code: LoadProblemCode,
      detail: string,
      dependency?: ExtensionId,
    ): void => {
      problems.push(
        dependency === undefined
          ? { extension, code, detail }
          : { extension, code, detail, dependency },
      );
    };

    const pending = new Map<ExtensionId, LoadUnit>();
    for (const unit of units) {
      const id = unit.id;
      if (this.#loaded.has(id) || pending.has(id)) {
        report(id, "duplicate", "an extension with this id is loaded already");
        continue;
      }
      if (!isApiCompatible(unit.api, this.apiVersion)) {
        report(
          id,
          "api-version",
          `written for interface ${unit.api.major}.${unit.api.minor}, host implements ${this.apiVersion.major}.${this.apiVersion.minor}`,
        );
        continue;
      }
      const invalid = this.#check(unit);
      if (invalid !== undefined) {
        report(id, "invalid", invalid);
        continue;
      }
      pending.set(id, unit);
    }

    const failed = new Set<ExtensionId>(problems.map((p) => p.extension));
    const settle = (id: ExtensionId, unit: LoadUnit): void => {
      pending.delete(id);
      const error = this.#activate(unit);
      if (error !== undefined) {
        report(id, "activate-failed", error);
        failed.add(id);
      }
    };
    // Settle one extension at a time: the first, in the given order, whose
    // dependencies are settled. So the order only changes where a dependency
    // requires it.
    while (pending.size > 0) {
      let progress = false;
      for (const [id, unit] of pending) {
        let ready = true;
        let blocked: { dependency: ExtensionId; code: LoadProblemCode } | undefined;
        for (const dep of unit.dependencies) {
          if (this.#loaded.has(dep.id)) continue;
          if (pending.has(dep.id)) {
            ready = false;
            continue;
          }
          if (dep.optional === true) continue;
          blocked = {
            dependency: dep.id,
            code: failed.has(dep.id) ? "dependency-failed" : "missing-dependency",
          };
          break;
        }
        if (blocked !== undefined) {
          report(id, blocked.code, `needs ${blocked.dependency}`, blocked.dependency);
          failed.add(id);
          pending.delete(id);
          progress = true;
          break;
        }
        if (!ready) continue;
        settle(id, unit);
        progress = true;
        break;
      }
      if (progress) continue;
      // Everything left waits for something pending. If one only waits for
      // optional dependencies, those cannot come first: activate it without them.
      const free = [...pending].find(([, unit]) =>
        unit.dependencies.every(
          (dep) => dep.optional === true || this.#loaded.has(dep.id),
        ),
      );
      if (free === undefined) break;
      settle(free[0], free[1]);
    }
    // What is left waits for itself: a cycle of required dependencies.
    for (const id of pending.keys()) {
      report(id, "cycle", "its dependencies form a cycle");
    }
    this.#problems.push(...problems);
    return problems;
  }

  /**
   * Unloads an extension, after the active extensions that require it (which
   * are unloaded too; those that only use it optionally stay). Elements of its
   * types become placeholders; their data is untouched. Returns the ids
   * unloaded, in order.
   */
  unload(id: ExtensionId): ExtensionId[] {
    if (!this.#loaded.has(id)) return [];
    const doomed = new Set<ExtensionId>([id]);
    const order = [...this.#loaded.keys()];
    for (const other of order) {
      const deps = this.#loaded.get(other)?.unit.dependencies ?? [];
      if (deps.some((dep) => dep.optional !== true && doomed.has(dep.id)))
        doomed.add(other);
    }
    const unloaded: ExtensionId[] = [];
    for (const other of order.reverse()) {
      if (!doomed.has(other)) continue;
      const loaded = this.#loaded.get(other)!;
      this.#loaded.delete(other);
      for (const undo of loaded.undo.reverse()) undo();
      try {
        loaded.unit.deactivate();
      } catch {
        // Nothing to do: its contributions are gone already.
      }
      unloaded.push(other);
    }
    return unloaded;
  }

  /** Checks a unit before anything of it is used; returns what is wrong. */
  #check(unit: LoadUnit): string | undefined {
    const id = unit.id;
    if (typeof id !== "string" || !EXTENSION_ID_PATTERN.test(id))
      return "invalid extension id";
    const namespaces = new Map<string, MessageBundle>();
    for (const bundle of unit.messages) {
      if (!ownsNamespace(id, bundle.namespace))
        return `message namespace ${bundle.namespace} is not the extension id or a prefix of it`;
      namespaces.set(bundle.namespace, bundle);
    }
    for (const dep of unit.dependencies) {
      if (!EXTENSION_ID_PATTERN.test(dep.id)) return `invalid dependency id ${dep.id}`;
      if (dep.id === id) return "depends on itself";
    }
    const allowedNamespace = (namespace: string): boolean =>
      namespace === "common" ||
      namespaces.has(namespace) ||
      unit.dependencies.some((dep) => ownsNamespace(dep.id, namespace));

    for (const [kind, list] of unit.lists) {
      const names = new Set<string>();
      for (const item of list) {
        if (!CONTRIBUTION_NAME_PATTERN.test(item.name))
          return `invalid ${kind} name ${item.name}`;
        if (names.has(item.name)) return `two of its ${kind}s are named ${item.name}`;
        names.add(item.name);
        const labels: string[] = [];
        labelsIn(item, labels);
        for (const label of labels) {
          const colon = label.indexOf(":");
          const namespace = label.slice(0, colon);
          if (colon < 1 || !allowedNamespace(namespace))
            return `${kind} ${item.name}: label ${label} is not in its own, a dependency's or the common namespace`;
          const bundle = namespaces.get(namespace);
          if (bundle && !Object.hasOwn(bundle.messages.nb, label.slice(colon + 1)))
            return `${kind} ${item.name}: label ${label} is not in its messages`;
        }
      }
    }
    return unit.check();
  }

  /** Activates one unit and offers its contributions; returns an error, if any. */
  #activate(unit: LoadUnit): string | undefined {
    const id = unit.id;
    const undo: Array<() => void> = [];
    try {
      for (const bundle of unit.messages) {
        if (this.#i18n) {
          this.#i18n.register(bundle);
          // A namespace shared by several extensions stays until the last goes.
          undo.push(() => {
            if (
              ![...this.#loaded.values()].some((l) =>
                l.unit.messages.some((b) => b.namespace === bundle.namespace),
              )
            )
              this.#i18n?.unregister(bundle.namespace);
          });
        }
      }
      unit.activate({
        extension: id,
        apiVersion: this.apiVersion,
        isActive: (other) => this.#loaded.has(other),
      });
      undo.push(...unit.offer());
    } catch (error) {
      for (const step of undo.reverse()) step();
      return error instanceof Error ? error.message : String(error);
    }
    this.#loaded.set(id, { unit, undo });
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Element types and transitions
  // -------------------------------------------------------------------------

  /** The viewing part of an element type id, if its extension is loaded. */
  elementView(type: string): AnyElementView | undefined {
    return this.#elementTypes.get(type)?.definition;
  }

  /** Every element type, in activation order. */
  elementViews(): Registered<AnyElementView>[] {
    return [...this.#elementTypes.values()];
  }

  /**
   * How an element is handled: by its extension; by core (frames and groups);
   * or as a placeholder, when the extension is missing or older than the
   * element's data.
   */
  resolve(element: ElementFacts): ElementTypeResolution {
    if (element.type === FRAME_TYPE || element.type === GROUP_TYPE)
      return { status: "core" };
    const type = this.#elementTypes.get(element.type);
    if (!type) return { status: "placeholder", reason: "missing" };
    if (element.typeVersion > type.definition.typeVersion)
      return { status: "placeholder", reason: "newer" };
    return { status: "known", type };
  }

  /**
   * Reads an element's data with its type. Undefined for core types and
   * placeholders. `problems` lists what was read as a default.
   */
  read(
    element: ElementFacts & { readonly data: ElementData },
  ): { readonly model: unknown; readonly problems: readonly string[] } | undefined {
    const resolved = this.resolve(element);
    if (resolved.status !== "known") return undefined;
    const problems: string[] = [];
    const model = resolved.type.definition.read(
      element.data,
      element.typeVersion,
      (path, problem) => problems.push(`${path}: ${problem}`),
    );
    return { model, problems };
  }

  /**
   * Draws an extension element in its local box: with its type, or as a
   * placeholder when the type is missing, older than the element, or throws
   * while drawing.
   */
  drawElement(
    ctx: DrawContext,
    element: ElementFacts & {
      readonly data: ElementData;
      readonly size?: Size | undefined;
    },
    id: ElementId,
  ): void {
    const box = { id, w: element.size?.w ?? 0, h: element.size?.h ?? 0 };
    const resolved = this.resolve(element);
    if (resolved.status === "core") return;
    if (resolved.status === "placeholder") {
      drawPlaceholder(ctx, box, resolved.reason, element.type);
      return;
    }
    try {
      const model = resolved.type.definition.read(
        element.data,
        element.typeVersion,
        () => {},
      );
      resolved.type.definition.draw(model, ctx, box);
    } catch {
      drawPlaceholder(ctx, box, "failed", element.type);
    }
  }

  transitions(mode?: Mode): Registered<AnyTransition>[] {
    const all = [...this.#transitions.values()];
    return mode === undefined
      ? all
      : all.filter((r) => availableIn(r.definition.quick, mode));
  }

  transition(id: ContributionId): AnyTransition | undefined {
    return this.#transitions.get(id)?.definition;
  }
}
