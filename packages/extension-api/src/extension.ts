// SPDX-License-Identifier: GPL-3.0-or-later

// The extension manifest: who an extension is, what it needs, and what it
// contributes. See docs/adr/0005-extension-interface.md, section 9.

import type { MessageBundle } from "@galatsa/i18n";
import type { CommandDefinition } from "./command.ts";
import type { AnyElementType } from "./element-type.ts";
import type { ApiVersion, ExtensionId } from "./ids.ts";
import type { PanelDefinition } from "./panel.ts";
import type { ToolDefinition } from "./tool.ts";
import type { ExporterDefinition, ImporterDefinition } from "./transfer.ts";
import type { AnyTransition } from "./transition.ts";

export interface ExtensionDependency {
  readonly id: ExtensionId;
  /**
   * An optional dependency is activated first when it is there, and its
   * absence is no problem; the extension checks `isActive` to use it.
   */
  readonly optional?: boolean;
}

/** Everything an extension adds, declared up front so the host can check it before activation. */
export interface Contributions {
  readonly elementTypes?: readonly AnyElementType[];
  readonly tools?: readonly ToolDefinition[];
  /** Commands of any argument and result types (their methods are checked bivariantly). */
  readonly commands?: readonly CommandDefinition[];
  readonly importers?: readonly ImporterDefinition[];
  readonly exporters?: readonly ExporterDefinition[];
  readonly transitions?: readonly AnyTransition[];
  readonly panels?: readonly PanelDefinition[];
}

export interface ActivationContext {
  readonly extension: ExtensionId;
  /** The interface version the host implements. */
  readonly apiVersion: ApiVersion;
  /** True if an extension is active (for optional dependencies). */
  isActive(id: ExtensionId): boolean;
}

export interface Extension {
  readonly id: ExtensionId;
  /** The extension's own version (semantic versioning), shown to users. */
  readonly version: string;
  /** The interface version it was written against. */
  readonly api: ApiVersion;
  readonly dependencies?: readonly ExtensionDependency[];
  /**
   * Its message bundles. Each namespace is the extension id or a prefix of it
   * made of whole words ("galatsa.shapes" for "galatsa.shapes.arrows"), so
   * extensions shipped together can share one bundle.
   */
  readonly messages?: readonly MessageBundle[];
  readonly contributes?: Contributions;
  /**
   * Called once, after its dependencies are active and before its
   * contributions are offered. Synchronous: an extension that needs to load
   * data does it lazily, when first used. Throwing makes the activation fail.
   */
  activate?(context: ActivationContext): void;
  /** Called once when it is unloaded, after its dependents are. */
  deactivate?(): void;
}

/** Identity function, for type checking a manifest where it is written. */
export function defineExtension(extension: Extension): Extension {
  return extension;
}
