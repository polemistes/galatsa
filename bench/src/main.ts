// SPDX-License-Identifier: GPL-3.0-or-later

// Placeholder until package F0-03 builds the real bench. It shows that code in bench/
// can use workspace packages from source, with no build first:
//   pnpm --filter @galatsa/bench start
// runs `node --conditions=@galatsa/source src/main.ts`.

import { CORE_VERSION } from "@galatsa/core";

console.log(`Galatsa bench placeholder, @galatsa/core ${CORE_VERSION}`);
