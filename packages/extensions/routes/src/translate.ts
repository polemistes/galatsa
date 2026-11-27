// SPDX-License-Identifier: GPL-3.0-or-later

// Translations a Svelte template reads reactively: its text changes with the
// language. The panel's own, so that the extension needs nothing of the
// editor at run time.

import type { I18n, MessageValues } from "@galatsa/i18n";
import { createSubscriber } from "svelte/reactivity";

export function translator(i18n: I18n): (key: string, values?: MessageValues) => string {
  const subscribe = createSubscriber((update) => i18n.subscribe(() => update()));
  return (key, values) => {
    subscribe();
    return i18n.t(key, values);
  };
}
