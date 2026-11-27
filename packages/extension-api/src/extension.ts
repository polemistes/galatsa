// SPDX-License-Identifier: GPL-3.0-or-later

// The viewing part of an extension manifest: who the extension is, what it
// needs, its texts, and what a viewer needs from it (element types and
// transitions). The editing part, which refers to it, is in edit-extension.ts.
// See docs/adr/0005-extension-interface.md, section 9.

import type { MessageBundle } from "@galatsa/i18n";
import type { AnyElementView } from "./element-type.ts";
import type { ApiVersion, ExtensionId } from "./ids.ts";
import type { AnyTransition } from "./transition.ts";

export interface ExtensionDependency {
  readonly id: ExtensionId;
  /**
   * An optional dependency is activated first when it is there, and its
   * absence is no problem; the extension checks `isActive` to use it.
   */
  readonly optional?: boolean;
}

export interface ActivationContext {
  readonly extension: ExtensionId;
  /** The interface version the host implements. */
  readonly apiVersion: ApiVersion;
  /** True if an extension is active (for optional dependencies). */
  isActive(id: ExtensionId): boolean;
}

/**
 * The viewing part of an extension: everything the player needs. It must not
 * import editing code (commands, tools, the document's Yjs operations), so a
 * viewer that loads it carries none of that.
 */
export interface ViewExtension {
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
  readonly elementTypes?: readonly AnyElementView[];
  readonly transitions?: readonly AnyTransition[];
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
export function defineViewExtension(extension: ViewExtension): ViewExtension {
  return extension;
}
