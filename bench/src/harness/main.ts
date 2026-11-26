// SPDX-License-Identifier: GPL-3.0-or-later

// The bench's own harness page (bench/index.html), with the no-op engine, the
// synthetic-load engine and the outline reference engine.

import { createNoopEngine } from "../engines/noop.ts";
import { createOutlineEngine } from "../engines/outline.ts";
import { createSyntheticEngine } from "../engines/synthetic.ts";
import { startHarness } from "./harness.ts";

startHarness({
  root: document.getElementById("app") ?? document.body,
  engines: [
    { id: "noop", create: createNoopEngine },
    { id: "synthetic", create: () => createSyntheticEngine() },
    { id: "outline", create: createOutlineEngine },
  ],
});
