// SPDX-License-Identifier: GPL-3.0-or-later

// The benchmark harness page with the DOM engine variants.

import { startHarness } from "@galatsa/bench/harness";
import { HARNESS_ENGINES } from "./engines.ts";

startHarness({
  root: document.getElementById("app") ?? document.body,
  engines: HARNESS_ENGINES,
});
