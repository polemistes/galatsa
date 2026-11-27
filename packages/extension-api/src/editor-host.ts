// SPDX-License-Identifier: GPL-3.0-or-later

// The editor's host: the viewing host plus the editing parts of extensions
// (commands, tools, panels, import, export, and the editing side of element
// types). See docs/adr/0005-extension-interface.md, section 9.

import { FRAME_TYPE } from "@galatsa/core";
import { CommandRegistry, type ExtensionLookup } from "./command.ts";
import type { EditExtension } from "./edit-extension.ts";
import type {
  AnyElementEditing,
  ElementCapabilities,
  RegisteredElementType,
} from "./element-editing.ts";
import type { ViewExtension } from "./extension.ts";
import type { FieldDefinition } from "./fields.ts";
import {
  ViewHost,
  viewUnit,
  type ElementFacts,
  type HostOptions,
  type LoadProblem,
  type LoadUnit,
  type Registered,
} from "./host.ts";
import { availableIn, type ContributionId, type Mode } from "./ids.ts";
import type { OverlayDefinition } from "./overlay.ts";
import type { PanelDefinition } from "./panel.ts";
import type { ToolDefinition } from "./tool.ts";
import type { ExporterDefinition, ImporterDefinition } from "./transfer.ts";

const CAPABILITIES_NONE: ElementCapabilities = {
  resize: false,
  rotate: false,
  editContent: false,
};

function isEdit(extension: ViewExtension | EditExtension): extension is EditExtension {
  return "view" in extension;
}

/**
 * The extension host of the editor. It loads viewing parts as the viewing host
 * does, and editing parts together with the viewing part they belong to: both
 * are checked, activated and unloaded as one extension.
 */
export class EditorHost extends ViewHost implements ExtensionLookup {
  readonly commands: CommandRegistry;
  readonly #editing = new Map<string, AnyElementEditing>();
  readonly #tools = new Map<ContributionId, Registered<ToolDefinition>>();
  readonly #importers = new Map<ContributionId, Registered<ImporterDefinition>>();
  readonly #exporters = new Map<ContributionId, Registered<ExporterDefinition>>();
  readonly #panels = new Map<ContributionId, Registered<PanelDefinition>>();
  readonly #overlays = new Map<ContributionId, Registered<OverlayDefinition>>();

  constructor(options: HostOptions = {}) {
    super(options);
    this.commands = new CommandRegistry(this);
  }

  /**
   * Loads extensions: editing parts with their viewing parts, and viewing parts
   * alone (an extension with nothing to edit).
   */
  override load(extensions: readonly (ViewExtension | EditExtension)[]): LoadProblem[] {
    return this.loadUnits(
      extensions.map((e) =>
        isEdit(e) ? this.#editUnit(e) : viewUnit(e, () => this.offerView(e)),
      ),
    );
  }

  #editUnit(extension: EditExtension): LoadUnit {
    const view = extension.view;
    const base = viewUnit(view, () => [
      ...this.offerView(view),
      ...this.#offerEditing(extension),
    ]);
    const c = extension.contributes;
    return {
      ...base,
      dependencies: [...base.dependencies, ...(extension.dependencies ?? [])],
      messages: [...base.messages, ...(extension.messages ?? [])],
      lists: [
        ...base.lists,
        ["element type editing", c.elementTypes ?? []],
        ["tool", c.tools ?? []],
        ["command", c.commands ?? []],
        ["importer", c.importers ?? []],
        ["exporter", c.exporters ?? []],
        ["panel", c.panels ?? []],
        ["overlay", c.overlays ?? []],
      ],
      check: () => {
        const own = base.check();
        if (own !== undefined) return own;
        const names = new Set((view.elementTypes ?? []).map((t) => t.name));
        for (const editing of c.elementTypes ?? []) {
          if (!names.has(editing.name))
            return `element type editing ${editing.name} has no element type of that name`;
          const fields = new Set<string>();
          for (const field of editing.properties ?? []) {
            if (fields.has(field.key))
              return `element type ${editing.name}: two fields have key ${field.key}`;
            fields.add(field.key);
          }
        }
        return undefined;
      },
      activate: (context) => {
        view.activate?.(context);
        extension.activate?.(context);
      },
      deactivate: () => {
        try {
          extension.deactivate?.();
        } finally {
          view.deactivate?.();
        }
      },
    };
  }

  #offerEditing(extension: EditExtension): Array<() => void> {
    const id = extension.view.id;
    const c = extension.contributes;
    const undo: Array<() => void> = [];
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
    for (const editing of c.elementTypes ?? []) {
      const key = `${id}/${editing.name}`;
      this.#editing.set(key, editing);
      undo.push(() => this.#editing.delete(key));
    }
    offer(this.#tools, c.tools);
    offer(this.#importers, c.importers);
    offer(this.#exporters, c.exporters);
    offer(this.#panels, c.panels);
    offer(this.#overlays, c.overlays);
    for (const command of c.commands ?? [])
      undo.push(this.commands.register(id, command));
    return undo;
  }

  // -------------------------------------------------------------------------
  // Element types
  // -------------------------------------------------------------------------

  elementType(type: string): RegisteredElementType | undefined {
    const resolved = this.resolve({ type, typeVersion: 1 });
    if (resolved.status !== "known") return undefined;
    return {
      id: resolved.type.id,
      extension: resolved.type.extension,
      view: resolved.type.definition,
      editing: this.#editing.get(type),
    };
  }

  /**
   * What the user may do to an element besides moving, stacking, reparenting,
   * locking, deleting and duplicating it, which every element allows. A
   * placeholder may do none of these; inside a group or a selection that is
   * scaled, it moves with the others and keeps its size (section 3.7).
   */
  capabilities(element: ElementFacts): ElementCapabilities {
    const resolved = this.resolve(element);
    if (resolved.status === "core") {
      // Frames have a size; a group is scaled by scaling its members. Neither rotates.
      return { resize: true, rotate: false, editContent: element.type === FRAME_TYPE };
    }
    if (resolved.status === "placeholder") return CAPABILITIES_NONE;
    const limits = this.#editing.get(element.type)?.capabilities ?? {};
    return {
      resize: limits.resize ?? true,
      rotate: limits.rotate ?? true,
      editContent: true,
    };
  }

  /** The properties an element type offers in a mode. */
  properties(type: string, mode: Mode): readonly FieldDefinition<unknown>[] {
    return (this.#editing.get(type)?.properties ?? []).filter((f) =>
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

  panels(mode?: Mode): Registered<PanelDefinition>[] {
    return this.#inMode(this.#panels, mode);
  }

  /** Overlays, in activation order. */
  overlays(mode?: Mode): Registered<OverlayDefinition>[] {
    return this.#inMode(this.#overlays, mode);
  }
}
