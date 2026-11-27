// SPDX-License-Identifier: GPL-3.0-or-later

// Panels: user interface an extension adds to the editor, described without a
// user interface library. See docs/adr/0005-extension-interface.md, section 8.

import type { CommandContext } from "./command.ts";
import type { FieldDefinition } from "./fields.ts";
import type { IconRef, Label } from "./ids.ts";

/**
 * Custom panel views, by user interface binding. Empty here; a binding adds
 * its kind by declaration merging, for example the React binding:
 *
 *   declare module "@galatsa/extension-api" {
 *     interface CustomPanelViews { react: ComponentType<PanelProps> }
 *   }
 *
 * Until a binding is loaded, only panels of fields can be written.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled by declaration merging
export interface CustomPanelViews {}

/** A custom view for one binding. */
export type CustomPanelContent = {
  readonly [B in keyof CustomPanelViews]: {
    readonly kind: "custom";
    readonly binding: B;
    readonly view: CustomPanelViews[B];
  };
}[keyof CustomPanelViews];

export type PanelContent =
  /** Controls for values, read from the editor context; changes run commands. */
  | {
      readonly kind: "fields";
      readonly fields: readonly FieldDefinition<CommandContext>[];
    }
  | CustomPanelContent;

export interface PanelDefinition {
  /** Panel name; the panel id is "<extension id>/<name>". */
  readonly name: string;
  readonly label: Label;
  readonly icon?: IconRef;
  /** Offered in quick mode too. Every panel is offered in advanced mode. */
  readonly quick?: boolean;
  /** Where the editor puts it. */
  readonly location: "side" | "bottom" | "floating";
  /** Whether it is shown now (for example only when something is selected). Default: always. */
  visible?(ctx: CommandContext): boolean;
  readonly content: PanelContent;
}
