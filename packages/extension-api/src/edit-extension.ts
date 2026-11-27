// SPDX-License-Identifier: GPL-3.0-or-later

// The editing part of an extension manifest. It refers to the viewing part, so
// the editor loads both, while the player imports only the viewing part and
// none of the editing code. See docs/adr/0005-extension-interface.md, section 9.

import type { MessageBundle } from "@galatsa/i18n";
import type { CommandDefinition } from "./command.ts";
import type { AnyElementEditing } from "./element-editing.ts";
import type {
  ActivationContext,
  ExtensionDependency,
  ViewExtension,
} from "./extension.ts";
import type { OverlayDefinition } from "./overlay.ts";
import type { PanelDefinition } from "./panel.ts";
import type { ToolDefinition } from "./tool.ts";
import type { ExporterDefinition, ImporterDefinition } from "./transfer.ts";

/** What the editing part adds, declared up front so the host can check it before activation. */
export interface EditContributions {
  /** Editing parts of the view's element types, by the same names. */
  readonly elementTypes?: readonly AnyElementEditing[];
  readonly tools?: readonly ToolDefinition[];
  /** Commands of any argument and result types (their methods are checked bivariantly). */
  readonly commands?: readonly CommandDefinition[];
  readonly importers?: readonly ImporterDefinition[];
  readonly exporters?: readonly ExporterDefinition[];
  readonly panels?: readonly PanelDefinition[];
  /** Drawn over the canvas outside any tool (docs/adr/0013). */
  readonly overlays?: readonly OverlayDefinition[];
}

export interface EditExtension {
  /** The viewing part; it gives the id, version, interface version and texts. */
  readonly view: ViewExtension;
  /** Dependencies of the editing part only (for example on the editor's own extension). */
  readonly dependencies?: readonly ExtensionDependency[];
  /** Bundles only the editor needs; same namespace rule as the view's. */
  readonly messages?: readonly MessageBundle[];
  readonly contributes: EditContributions;
  /** Called after the view's `activate`. */
  activate?(context: ActivationContext): void;
  /** Called before the view's `deactivate`. */
  deactivate?(): void;
}

/** Identity function, for type checking a manifest where it is written. */
export function defineEditExtension(extension: EditExtension): EditExtension {
  return extension;
}
