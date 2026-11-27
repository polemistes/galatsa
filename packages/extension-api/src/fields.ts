// SPDX-License-Identifier: GPL-3.0-or-later

// Fields: a declarative description of one adjustable value, shown by the
// editor as a control in a properties panel or a panel of fields. Changing the
// value runs a command, so every change is one undo step. See
// docs/adr/0005-extension-interface.md, section 3.9.

import type { ElementId, Json } from "@galatsa/core";
import type { ContributionId, Label } from "./ids.ts";

export interface SelectOption {
  readonly value: Json;
  readonly label: Label;
}

/** The control the editor shows for a field. */
export type Control =
  | {
      readonly kind: "number";
      readonly min?: number;
      readonly max?: number;
      readonly step?: number;
      /** Unit shown after the value, as a label ("examples:unit.px"). */
      readonly unit?: Label;
    }
  | { readonly kind: "color"; readonly allowNone?: boolean }
  | { readonly kind: "select"; readonly options: readonly SelectOption[] }
  | { readonly kind: "toggle" }
  | { readonly kind: "text"; readonly multiline?: boolean };

/**
 * Arguments of the command a field runs: the elements the field was shown for
 * (empty for panels that are not about elements), the field's key, and the new
 * value.
 */
export interface FieldChange {
  readonly ids: readonly ElementId[];
  readonly key: string;
  readonly value: Json;
}

/**
 * One adjustable value. `S` is what the value is read from: an element type's
 * model for element properties, the editor context for panels.
 */
export interface FieldDefinition<S> {
  /** Unique within its list; passed to the command. */
  readonly key: string;
  readonly label: Label;
  /** Offered in quick mode too. Every field is offered in advanced mode. */
  readonly quick?: boolean;
  readonly control: Control;
  /**
   * The current value. For several selected elements the editor reads each and
   * shows a mixed state when they differ.
   */
  get(source: S): Json;
  /**
   * Whether the field applies to this source (since 1.3). An element type with
   * several variants (the shape type's kinds) lists every field once and says
   * here which elements each one is for: corner rounding only for kinds with
   * corners. The editor shows a field for a selection only when it applies to
   * every selected element. Without it, the field always applies.
   */
  applies?(source: S): boolean;
  /** Command run with a FieldChange when the user changes the value. */
  readonly command: ContributionId;
}
