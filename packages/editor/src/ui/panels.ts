// SPDX-License-Identifier: GPL-3.0-or-later

// The Svelte binding for custom panels (docs/adr/0005, section 8): a panel may
// bring its own view as a Svelte component. Panels of fields are drawn by the
// editor's field renderer, which comes with the editor shell; until then they
// are not shown.

import type {
  CommandContext,
  PanelDefinition,
  Registered,
} from "@galatsa/extension-api/editing";
import type { I18n } from "@galatsa/i18n";
import type { Component } from "svelte";

/** What a custom panel's Svelte component gets. */
export interface PanelProps {
  /** The command context of the editor's document now (services, history, run). */
  readonly context: CommandContext;
  /**
   * The program's translations, for the panel's text in the language the
   * user chose (docs/adr/0013: a custom panel had no way to its text).
   */
  readonly i18n: I18n;
}

declare module "@galatsa/extension-api/editing" {
  interface CustomPanelViews {
    /** A Svelte component, for panels that need an interface of their own. */
    readonly svelte?: Component<PanelProps>;
  }
}

/** The Svelte component of a panel, or null for panels of another kind. */
export function svelteView(
  panel: Registered<PanelDefinition>,
): Component<PanelProps> | null {
  const content = panel.definition.content;
  return content.kind === "custom" && content.binding === "svelte" ? content.view : null;
}
