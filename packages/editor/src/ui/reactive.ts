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

/** Translations that a template reads reactively: text changes with the language. */
export function translator(i18n: I18n): (key: string, values?: MessageValues) => string {
  const language = new Watched(i18n, () => i18n.version);
  return (key, values) => {
    void language.current;
    return i18n.t(key, values);
  };
}
