// SPDX-License-Identifier: GPL-3.0-or-later

// Checks every storage backend must pass, written without a test framework so
// that they also run in browsers (IndexedDB) and later against the desktop file
// system. Entry "@galatsa/storage/testing"; not part of the production entry.

import type { StorageBackend } from "./backend.ts";

function fail(what: string): never {
  throw new Error(`Backend contract: ${what}`);
}

function same(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/**
 * Runs the backend contract (StorageBackend's documented guarantees that can be
 * observed from one program) under `prefix`, and removes what it wrote.
 * Throws an Error that names the first broken rule.
 */
export async function checkBackendContract(
  backend: StorageBackend,
  prefix = "contract/",
): Promise<void> {
  const k = (name: string) => `${prefix}${name}`;
  await backend.remove(await backend.list(prefix));

  if ((await backend.read(k("missing"))) !== undefined)
    fail("a missing key reads as undefined");

  const a = bytes(1000, 1);
  await backend.write(k("a"), a);
  if (!same(await backend.read(k("a")), a)) fail("write then read gives the bytes back");

  const input = bytes(10, 2);
  await backend.write(k("copy"), input);
  input[0] = (input[0]! + 1) & 0xff;
  const stored = await backend.read(k("copy"));
  if (same(stored, input)) fail("a write keeps its own copy of the bytes");
  stored![1] = (stored![1]! + 1) & 0xff;
  if (same(await backend.read(k("copy")), stored!)) fail("a read returns its own copy");

  const b = bytes(500, 3);
  await backend.write(k("a"), b);
  if (!same(await backend.read(k("a")), b)) fail("write replaces the value");

  const empty = new Uint8Array(0);
  await backend.write(k("empty"), empty);
  const readEmpty = await backend.read(k("empty"));
  if (readEmpty === undefined || readEmpty.length !== 0) fail("an empty value is stored");

  const c = bytes(100, 4);
  if (!(await backend.create(k("c"), c))) fail("create of an absent key returns true");
  if (await backend.create(k("c"), bytes(100, 5)))
    fail("create of a present key returns false");
  if (!same(await backend.read(k("c")), c)) fail("a refused create changes nothing");

  // Two creates of the same key at the same time: exactly one wins.
  const racers = await Promise.all([
    backend.create(k("race"), bytes(50, 6)),
    backend.create(k("race"), bytes(50, 7)),
    backend.create(k("race"), bytes(50, 8)),
  ]);
  if (racers.filter(Boolean).length !== 1)
    fail("of concurrent creates exactly one succeeds");
  const winner = [6, 7, 8][racers.indexOf(true)]!;
  if (!same(await backend.read(k("race")), bytes(50, winner))) {
    fail("the winning create's bytes are stored");
  }

  await backend.write(k("d/x/1"), bytes(1, 9));
  await backend.write(k("d/x/2"), bytes(1, 10));
  await backend.write(k("d/y"), bytes(1, 11));
  await backend.write(k("dz"), bytes(1, 12));
  const listed = await backend.list(k("d/"));
  const expected = [k("d/x/1"), k("d/x/2"), k("d/y")];
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    fail(
      `list gives exactly the keys under the prefix, sorted: ${JSON.stringify(listed)}`,
    );
  }

  await backend.remove([k("d/x/1"), k("nothing-here")]);
  if ((await backend.read(k("d/x/1"))) !== undefined) fail("remove removes");
  if ((await backend.read(k("d/x/2"))) === undefined) fail("remove leaves other keys");
  await backend.remove([]);

  const large = bytes(8 * 1024 * 1024 + 3, 13);
  await backend.write(k("large"), large);
  if (!same(await backend.read(k("large")), large))
    fail("a value of 8 MiB is stored whole");

  await backend.remove(await backend.list(prefix));
  if ((await backend.list(prefix)).length !== 0) fail("everything written was removed");
}
