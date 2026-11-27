// SPDX-License-Identifier: GPL-3.0-or-later

// Element types, editing part: what only the editor needs. It refers to the
// viewing part by name and shares its model type. See
// docs/adr/0005-extension-interface.md, section 3.

import type { ElementData, Rect } from "@galatsa/core";
import type { ElementBox, ElementTypeView } from "./element-type.ts";
import type { TextStyle } from "./draw.ts";
import type { FieldDefinition } from "./fields.ts";
import type { ContributionId, ExtensionId } from "./ids.ts";

/** What the user may do to an element besides moving, stacking, grouping and deleting it. */
export interface ElementCapabilities {
  /** Change the size of the box (also when a group or selection around it is scaled). */
  readonly resize: boolean;
  /** Change the rotation. */
  readonly rotate: boolean;
  /** Change the content (data), through the type's commands, fields and text editing. */
  readonly editContent: boolean;
}

/**
 * Where in-place text editing happens for a text-like element: the renderer's
 * beginTextEdit lays an editable browser element over `box`, styled with
 * `style`, bound to the shared text at data key `key`, using the same line
 * breaks as the drawn text.
 */
export interface TextEditTarget {
  /** Data key of the Y.Text being edited. */
  readonly key: string;
  readonly style: TextStyle;
  /** The text area, in the element's local box. */
  readonly box: Rect;
  /**
   * The box height follows the text: the editor resizes the element in the
   * same undo step as the typing that changed the height (section 3.5).
   */
  readonly autoHeight?: boolean;
}

/**
 * The editing part of an element type. `name` is the name of the viewing part
 * it belongs to, in the same extension.
 */
export interface ElementTypeEditing<M> {
  readonly name: string;

  /**
   * The data writes that bring data written in layout `from` up to the current
   * layout, for keys whose meaning changed: keys to set, in their new values.
   * Optional: keys a newer layout added need no upgrade, because readers read
   * a missing key as its default, and that default MUST mean what older layouts
   * implied. Called only before a user's edit of the element, never on load;
   * the host writes the result and the new type version in a transaction of its
   * own that undo does not take back (section 3.8).
   */
  upgrade?(data: ElementData, from: number): ElementData;

  /**
   * The ids of elements and stops the data refers to. The host keeps the
   * envelope's `refs` equal to this whenever a command writes data through it,
   * so copy and paste remap the references (docs/adr/0001, section 3.5).
   */
  references?(model: M): readonly string[];

  /** For text-like types: where in-place editing happens, or null if not now. */
  textEditing?(model: M, box: ElementBox): TextEditTarget | null;

  /** Limits on what the user may do; the default allows resizing and rotating. */
  readonly capabilities?: Partial<Pick<ElementCapabilities, "resize" | "rotate">>;

  /**
   * The element's adjustable properties, for the editor's properties panel. A
   * field marked `quick` is shown in quick mode too.
   */
  readonly properties?: readonly FieldDefinition<M>[];
}

export type AnyElementEditing = ElementTypeEditing<unknown>;

/** Builds the editing part for a view, with the view's model type. */
export function defineElementEditing<M>(
  view: ElementTypeView<M>,
  editing: Omit<ElementTypeEditing<M>, "name">,
): ElementTypeEditing<M> {
  return { name: view.name, ...editing };
}

/** Both parts of a loaded element type. */
export interface RegisteredElementType {
  readonly id: ContributionId;
  readonly extension: ExtensionId;
  readonly view: ElementTypeView<unknown>;
  readonly editing: AnyElementEditing | undefined;
}
