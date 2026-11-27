// SPDX-License-Identifier: GPL-3.0-or-later

import { defineMessages } from "@galatsa/i18n";
import en from "./en.ts";
import nb from "./nb.ts";

/**
 * One bundle for the three example extensions. Its namespace, "examples", is a
 * whole-word prefix of each of their ids, which is what lets them share it.
 */
export const exampleMessages = defineMessages("examples", { nb, en });
