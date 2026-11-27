// SPDX-License-Identifier: GPL-3.0-or-later

// The editor's stores in Svelte: the current value of a store that tells its
// listeners when it changes (the program, a document, the editor), and the
// translations, which follow a change of language.

import type { I18n } from "@galatsa/i18n";
import type { MessageValues } from "@galatsa/i18n";
import { createSubscriber } from "svelte/reactivity";

/** A store as the editor's objects are: a subscription and a way to read it. */
export interface Store {
  subscribe(listener: () => void): () => void;
}

/**
 * Reads `read()` reactively: an effect or a template that reads `current`
 * runs again when the store tells of a change.
 */
export class Watched<T> {
  readonly #read: () => T;
  readonly #subscribe: () => void;

  constructor(store: Store, read: () => T) {
    this.#read = read;
    this.#subscribe = createSubscriber((update) => store.subscribe(() => update()));
  }

  get current(): T {
    this.#subscribe();
    return this.#read();
  }
}

/** What the editor's change store needs of the editor. */
interface ChangingEditor extends Store {
  readonly doc: {
    on(event: "update", listener: () => void): void;
    off(event: "update", listener: () => void): void;
  };
  readonly undo: {
    on(event: UndoEvent, listener: () => void): void;
    off(event: UndoEvent, listener: () => void): void;
  };
}

type UndoEvent = "stack-item-added" | "stack-item-popped" | "stack-cleared";

const UNDO_EVENTS: readonly UndoEvent[] = [
  "stack-item-added",
  "stack-item-popped",
  "stack-cleared",
];

/**
 * A store that tells of every change the toolbar and the properties panel
 * show: the editor's own (selection, tool, mode, panels, text editing), the
 * document's (values, what can be done) and the undo stacks'.
 */
export function editorChanges(editor: ChangingEditor): Store {
  return {
    subscribe(listener) {
      const changed = (): void => listener();
      const stop = editor.subscribe(changed);
      editor.doc.on("update", changed);
      for (const event of UNDO_EVENTS) editor.undo.on(event, changed);
      return () => {
        stop();
        editor.doc.off("update", changed);
        for (const event of UNDO_EVENTS) editor.undo.off(event, changed);
      };
    },
  };
}

/** Translations that a template reads reactively: text changes with the language. */
export function translator(i18n: I18n): (key: string, values?: MessageValues) => string {
  const language = new Watched(i18n, () => i18n.version);
  return (key, values) => {
    void language.current;
    return i18n.t(key, values);
  };
}
