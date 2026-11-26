// SPDX-License-Identifier: GPL-3.0-or-later

// Shared messages in English (namespace "common"). Keys must match nb.ts;
// `pnpm check` compares them. Syntax: see ../message-format.ts.

export default {
  "action.ok": "OK",
  "action.cancel": "Cancel",
  "action.close": "Close",
  "language.label": "Language",
  "error.unexpected": "Something went wrong. Please try again.",
  "selection.count":
    "{count, plural, =0 {Nothing is selected} one {# element is selected} other {# elements are selected}}",
};
