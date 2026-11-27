// SPDX-License-Identifier: GPL-3.0-or-later

// React bindings for the editor's stores: translations that follow a change of
// language, and the state of the program, the document and the editor.

import type { I18n } from "@galatsa/i18n";
import { useCallback, useSyncExternalStore } from "react";

/** The program's translations; the component renders again when the language changes. */
export function useI18n(i18n: I18n): I18n {
  useSyncExternalStore(
    i18n.subscribe,
    () => i18n.version,
    () => i18n.version,
  );
  return i18n;
}

/** A store's current value, rendered again when it changes. */
export function useStore<T>(
  store: { subscribe(listener: () => void): () => void } | null,
  read: () => T,
): T {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(() => listener()) : () => {}),
    [store],
  );
  return useSyncExternalStore(subscribe, read, read);
}
