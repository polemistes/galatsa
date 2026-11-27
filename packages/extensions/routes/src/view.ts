// SPDX-License-Identifier: GPL-3.0-or-later

// The viewing part of the routes extension, for a viewer (the player): its
// messages only, since playing routes is the player's own. Imports no editing
// code, no panel and no editor ("@galatsa/extension-routes/view").

import { EXTENSION_API_VERSION, defineViewExtension } from "@galatsa/extension-api";
import { routesMessages } from "./messages/index.ts";

/** The extension's id, and its message namespace. */
export const ROUTES_EXTENSION = "galatsa.routes";

export { routesMessages };

export const routesViewExtension = defineViewExtension({
  id: ROUTES_EXTENSION,
  version: "0.1.0",
  api: EXTENSION_API_VERSION,
  messages: [routesMessages],
});
