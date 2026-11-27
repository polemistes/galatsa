// SPDX-License-Identifier: GPL-3.0-or-later

// The worker module that builds checkpoints (entry
// "@galatsa/storage/checkpoint-worker"). A program starts it as a module worker
// and passes the Worker to `workerEncoder`. With Vite:
//
//   import CheckpointWorker from "@galatsa/storage/checkpoint-worker?worker";
//   const encoder = workerEncoder(new CheckpointWorker());

import { serveCheckpoints } from "./worker.ts";

serveCheckpoints(globalThis as unknown as Parameters<typeof serveCheckpoints>[0]);
