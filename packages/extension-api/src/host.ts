// SPDX-License-Identifier: GPL-3.0-or-later

// The extension host: loads extensions in dependency order, checks them,
// activates them, and offers their contributions to the editor, the renderer
// and the player. See docs/adr/0005-extension-interface.md, section 9.

import {
  FRAME_TYPE,
  GROUP_TYPE,
  type ElementData,
  type ElementId,
  type Size,
} from "@galatsa/core";
import type { MessageBundle, MessageValues } from "@galatsa/i18n";
import { CommandRegistry, type ExtensionLookup } from "./command.ts";
import type { DrawContext } from "./draw.ts";
import type { AnyElementType, ElementCapabilities } from "./element-type.ts";
import type { Extension } from "./extension.ts";
import type { FieldDefinition } from "./fields.ts";
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
import type { PanelDefinition } from "./panel.ts";
import { drawPlaceholder, type PlaceholderReason } from "./placeholder.ts";
import type { ToolDefinition } from "./tool.ts";
import type { ExporterDefinition, ImporterDefinition } from "./transfer.ts";
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
  | { readonly status: "known"; readonly type: Registered<AnyElementType> }
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

interface Loaded {
  readonly extension: Extension;
  readonly undo: Array<() => void>;
}

const CAPABILITIES_NONE: ElementCapabilities = {
  resize: false,
  rotate: false,
  editContent: false,
};

/** True if `namespace` is `id` or a prefix of it made of whole words. */
function ownsNamespace(id: ExtensionId, namespace: string): boolean {
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

/**
 * Loads extensions and offers their contributions. Each extension is checked
 * as a whole; one that fails is reported and left out, with the extensions
 * that need it, and never stops the others.
 */
export class ExtensionHost implements ExtensionLookup {
  readonly apiVersion: ApiVersion;
  readonly commands: CommandRegistry;
  readonly #i18n: MessageRegistry | undefined;
  /** Active extensions, in activation order. */
  readonly #loaded = new Map<ExtensionId, Loaded>();
  readonly #problems: LoadProblem[] = [];
  readonly #elementTypes = new Map<string, Registered<AnyElementType>>();
  readonly #tools = new Map<ContributionId, Registered<ToolDefinition>>();
  readonly #importers = new Map<ContributionId, Registered<ImporterDefinition>>();
  readonly #exporters = new Map<ContributionId, Registered<ExporterDefinition>>();
  readonly #transitions = new Map<ContributionId, Registered<AnyTransition>>();
  readonly #panels = new Map<ContributionId, Registered<PanelDefinition>>();

  constructor(options: HostOptions = {}) {
    this.apiVersion = options.apiVersion ?? EXTENSION_API_VERSION;
    this.#i18n = options.i18n;
    this.#i18n?.register(extensionMessages);
    this.commands = new CommandRegistry(this);
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
   * Loads extensions: checks them, orders them by their dependencies (keeping
   * the given order otherwise) and activates them. Extensions loaded earlier
   * stay. Returns the problems of this load.
   */
  load(extensions: readonly Extension[]): LoadProblem[] {
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

    const pending = new Map<ExtensionId, Extension>();
    for (const extension of extensions) {
      const id = extension.id;
      if (this.#loaded.has(id) || pending.has(id)) {
        report(id, "duplicate", "an extension with this id is loaded already");
        continue;
      }
      if (!isApiCompatible(extension.api, this.apiVersion)) {
        report(
          id,
          "api-version",
          `written for interface ${extension.api.major}.${extension.api.minor}, host implements ${this.apiVersion.major}.${this.apiVersion.minor}`,
        );
        continue;
      }
      const invalid = this.#check(extension);
      if (invalid !== undefined) {
        report(id, "invalid", invalid);
        continue;
      }
      pending.set(id, extension);
    }

    const failed = new Set<ExtensionId>(problems.map((p) => p.extension));
    // Settle one extension at a time: the first, in the given order, whose
    // dependencies are settled. So the order only changes where a dependency
    // requires it.
    let progress = true;
    while (pending.size > 0 && progress) {
      progress = false;
      for (const [id, extension] of pending) {
        const deps = extension.dependencies ?? [];
        let ready = true;
        let blocked: { dependency: ExtensionId; code: LoadProblemCode } | undefined;
        for (const dep of deps) {
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
        pending.delete(id);
        progress = true;
        const error = this.#activate(extension);
        if (error !== undefined) {
          report(id, "activate-failed", error);
          failed.add(id);
        }
        // Start again from the first: an earlier extension may be ready now.
        break;
      }
    }
    // What is left waits for itself: a dependency cycle.
    for (const id of pending.keys()) {
      report(id, "cycle", "its dependencies form a cycle");
    }
    this.#problems.push(...problems);
    return problems;
  }

  /**
   * Unloads an extension, after the active extensions that need it (which are
   * unloaded too). Elements of its types become placeholders; their data is
   * untouched. Returns the ids unloaded, in order.
   */
  unload(id: ExtensionId): ExtensionId[] {
    if (!this.#loaded.has(id)) return [];
    const doomed = new Set<ExtensionId>([id]);
    const order = [...this.#loaded.keys()];
    for (const other of order) {
      const deps = this.#loaded.get(other)?.extension.dependencies ?? [];
      if (deps.some((dep) => doomed.has(dep.id))) doomed.add(other);
    }
    const unloaded: ExtensionId[] = [];
    for (const other of order.reverse()) {
      if (!doomed.has(other)) continue;
      const loaded = this.#loaded.get(other)!;
      this.#loaded.delete(other);
      for (const undo of loaded.undo.reverse()) undo();
      try {
        loaded.extension.deactivate?.();
      } catch {
        // Nothing to do: its contributions are gone already.
      }
      unloaded.push(other);
    }
    return unloaded;
  }

  /** Checks a manifest before anything of it is used; returns what is wrong. */
  #check(extension: Extension): string | undefined {
    const id = extension.id;
    if (typeof id !== "string" || !EXTENSION_ID_PATTERN.test(id))
      return "invalid extension id";
    const namespaces = new Map<string, MessageBundle>();
    for (const bundle of extension.messages ?? []) {
      if (!ownsNamespace(id, bundle.namespace))
        return `message namespace ${bundle.namespace} is not the extension id or a prefix of it`;
      namespaces.set(bundle.namespace, bundle);
    }
    for (const dep of extension.dependencies ?? []) {
      if (!EXTENSION_ID_PATTERN.test(dep.id)) return `invalid dependency id ${dep.id}`;
      if (dep.id === id) return "depends on itself";
    }
    const allowedNamespace = (namespace: string): boolean =>
      namespace === "common" ||
      namespaces.has(namespace) ||
      (extension.dependencies ?? []).some((dep) => ownsNamespace(dep.id, namespace));

    const c = extension.contributes ?? {};
    const lists: Array<[string, readonly { readonly name: string }[] | undefined]> = [
      ["element type", c.elementTypes],
      ["tool", c.tools],
      ["command", c.commands],
      ["importer", c.importers],
      ["exporter", c.exporters],
      ["transition", c.transitions],
      ["panel", c.panels],
    ];
    for (const [kind, list] of lists) {
      const names = new Set<string>();
      for (const item of list ?? []) {
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
    for (const type of c.elementTypes ?? []) {
      if (!Number.isInteger(type.typeVersion) || type.typeVersion < 1)
        return `element type ${type.name}: typeVersion must be an integer >= 1`;
      if (type.typeVersion > 1 && type.upgrade === undefined)
        return `element type ${type.name}: typeVersion ${type.typeVersion} needs an upgrade function`;
      const fields = new Set<string>();
      for (const field of type.properties ?? []) {
        if (fields.has(field.key))
          return `element type ${type.name}: two fields have key ${field.key}`;
        fields.add(field.key);
      }
    }
    return undefined;
  }

  /** Activates one extension and offers its contributions; returns an error, if any. */
  #activate(extension: Extension): string | undefined {
    const id = extension.id;
    const undo: Array<() => void> = [];
    try {
      for (const bundle of extension.messages ?? []) {
        if (this.#i18n) {
          this.#i18n.register(bundle);
          // A namespace shared by several extensions stays until the last goes.
          undo.push(() => {
            if (
              ![...this.#loaded.values()].some((l) =>
                l.extension.messages?.some((b) => b.namespace === bundle.namespace),
              )
            )
              this.#i18n?.unregister(bundle.namespace);
          });
        }
      }
      extension.activate?.({
        extension: id,
        apiVersion: this.apiVersion,
        isActive: (other) => this.#loaded.has(other),
      });
      const c = extension.contributes ?? {};
      const offer = <D extends { readonly name: string }>(
        map: Map<string, Registered<D>>,
        list: readonly D[] | undefined,
      ): void => {
        for (const definition of list ?? []) {
          const key = `${id}/${definition.name}`;
          map.set(key, { id: key, extension: id, definition });
          undo.push(() => map.delete(key));
        }
      };
      offer(this.#elementTypes, c.elementTypes);
      offer(this.#tools, c.tools);
      offer(this.#importers, c.importers);
      offer(this.#exporters, c.exporters);
      offer(this.#transitions, c.transitions);
      offer(this.#panels, c.panels);
      for (const command of c.commands ?? [])
        undo.push(this.commands.register(id, command));
    } catch (error) {
      for (const step of undo.reverse()) step();
      return error instanceof Error ? error.message : String(error);
    }
    this.#loaded.set(id, { extension, undo });
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Element types
  // -------------------------------------------------------------------------

  elementType(type: string): AnyElementType | undefined {
    return this.#elementTypes.get(type)?.definition;
  }

  /** Every element type, in activation order. */
  elementTypes(): Registered<AnyElementType>[] {
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
   * What the user may do to an element besides moving, stacking, grouping,
   * locking, deleting and duplicating it, which every element allows.
   */
  capabilities(element: ElementFacts): ElementCapabilities {
    const resolved = this.resolve(element);
    if (resolved.status === "core") {
      // Frames have a size; groups take theirs from their members. Neither rotates.
      return { resize: element.type === FRAME_TYPE, rotate: false, editContent: true };
    }
    if (resolved.status === "placeholder") return CAPABILITIES_NONE;
    const limits = resolved.type.definition.capabilities ?? {};
    return {
      resize: limits.resize ?? true,
      rotate: limits.rotate ?? true,
      editContent: true,
    };
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

  /** The properties an element type offers in a mode. */
  properties(type: string, mode: Mode): readonly FieldDefinition<unknown>[] {
    return (this.elementType(type)?.properties ?? []).filter((f) =>
      availableIn(f.quick, mode),
    );
  }

  // -------------------------------------------------------------------------
  // Other contributions
  // -------------------------------------------------------------------------

  #inMode<D extends { readonly quick?: boolean }>(
    map: Map<ContributionId, Registered<D>>,
    mode: Mode | undefined,
  ): Registered<D>[] {
    const all = [...map.values()];
    return mode === undefined
      ? all
      : all.filter((r) => availableIn(r.definition.quick, mode));
  }

  tools(mode?: Mode): Registered<ToolDefinition>[] {
    return this.#inMode(this.#tools, mode);
  }

  importers(mode?: Mode): Registered<ImporterDefinition>[] {
    return this.#inMode(this.#importers, mode);
  }

  /** Importers that take a file, by media type or name extension, in activation order. */
  importersFor(
    file: { readonly name: string; readonly mediaType?: string | undefined },
    mode?: Mode,
  ): Registered<ImporterDefinition>[] {
    const dot = file.name.lastIndexOf(".");
    const suffix = dot < 0 ? "" : file.name.slice(dot + 1).toLowerCase();
    return this.importers(mode).filter((r) =>
      r.definition.fileTypes.some(
        (t) =>
          (file.mediaType !== undefined && t.mediaTypes.includes(file.mediaType)) ||
          (suffix !== "" && t.extensions.includes(suffix)),
      ),
    );
  }

  exporters(mode?: Mode): Registered<ExporterDefinition>[] {
    return this.#inMode(this.#exporters, mode);
  }

  transitions(mode?: Mode): Registered<AnyTransition>[] {
    return this.#inMode(this.#transitions, mode);
  }

  transition(id: ContributionId): AnyTransition | undefined {
    return this.#transitions.get(id)?.definition;
  }

  panels(mode?: Mode): Registered<PanelDefinition>[] {
    return this.#inMode(this.#panels, mode);
  }
}
