// SPDX-License-Identifier: GPL-3.0-or-later

// Property tests of the file format, on the random scenarios and the random
// junk of @galatsa/core/testing: every file written at any moment reads back as
// the same document, with its merge identity, by both readers; what was written
// by a peer never changes that.
//
// 15 seeds by default; set GALATSA_FUZZ_SEEDS for a long run.

import {
  Resolver,
  lookupFromRecord,
  validateSnapshot,
  type DocumentSnapshot,
} from "@galatsa/core";
import { buildSampleDocument, runScenario, scribbleJunk } from "@galatsa/core/testing";
import { forkDoc, syncDocs, toSnapshot } from "@galatsa/core/ydoc";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readGalatsaFile, writeGalatsaFile } from "./file.ts";
import { readGalatsaSnapshot } from "./read.ts";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;
const SEEDS = Number(env?.GALATSA_FUZZ_SEEDS ?? 15);
const FIRST = Number(env?.GALATSA_FUZZ_FIRST ?? 1);
const none = () => undefined;

interface Written {
  expected: DocumentSnapshot;
  file: Uint8Array;
  shared: Uint8Array;
}

function write(doc: Y.Doc): Written {
  const full = writeGalatsaFile(doc, none);
  expect(full.warnings).toEqual([]);
  return {
    expected: toSnapshot(doc),
    file: full.bytes,
    shared: writeGalatsaFile(doc, none, { forSharing: true }).bytes,
  };
}

function seen(snapshot: DocumentSnapshot): unknown {
  const view = new Resolver(lookupFromRecord(snapshot.elements));
  return view.drawOrder().map((id) => {
    const at = view.worldOrigin(id);
    return [id, Math.round(at.x * 1e6) / 1e6, Math.round(at.y * 1e6) / 1e6];
  });
}

async function check(written: Written, where: string): Promise<void> {
  const read = await readGalatsaFile(written.file);
  expect(read.snapshot, where).toEqual(written.expected);
  expect(read.mergeIdentityKept, where).toBe(true);
  expect(
    read.warnings.filter((w) => w.code !== "asset-missing"),
    where,
  ).toEqual([]);
  expect((await readGalatsaSnapshot(written.file)).snapshot, where).toEqual(
    written.expected,
  );
  // An export for sharing shows the same and carries nothing that is removed.
  const shared = await readGalatsaFile(written.shared);
  expect(shared.mergeIdentityKept, where).toBe(false);
  expect(validateSnapshot(shared.snapshot), where).toEqual([]);
  expect(seen(shared.snapshot), where).toEqual(seen(written.expected));
  expect(Object.keys(shared.snapshot.elements).length, where).toBe(
    (seen(written.expected) as unknown[]).length,
  );
}

describe(`files written during random scenarios: ${SEEDS} seeds from ${FIRST}`, () => {
  it(
    "read back as the same document, and still merge",
    async () => {
      for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
        const files: Written[] = [];
        const result = runScenario(seed, { checkpoint: (doc) => files.push(write(doc)) });
        expect(result.failures).toEqual([]);
        expect(files.length).toBeGreaterThan(3);
        for (const [i, written] of files.entries()) {
          await check(written, `seed ${seed}, file ${i}`);
        }
        // A reopened file is still the same replica: it syncs with the others.
        const reopened = await readGalatsaFile(files[files.length - 1]!.file);
        const other = result.replicas[0]!;
        syncDocs(reopened.doc, other);
        expect(toSnapshot(reopened.doc)).toEqual(toSnapshot(other));
      }
    },
    Math.max(30_000, SEEDS * 2000),
  );
});

describe(`files of documents a peer scribbled in: ${SEEDS} seeds`, () => {
  it(
    "open, with the document every replica sees",
    async () => {
      for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
        const doc = buildSampleDocument(new Y.Doc(), seed);
        scribbleJunk(doc, seed);
        const where = `seed ${seed}`;
        const expected = toSnapshot(doc);
        for (const includeYdoc of [true, false]) {
          const written = writeGalatsaFile(doc, none, { includeYdoc });
          expect(written.warnings, where).toEqual([]);
          const read = await readGalatsaFile(written.bytes);
          expect(read.snapshot, where).toEqual(expected);
          expect(read.mergeIdentityKept, where).toBe(includeYdoc);
          expect(
            read.warnings
              .map((w) => w.code)
              .filter((c) => c !== "asset-missing" && c !== "asset-undescribed"),
            where,
          ).toEqual(includeYdoc ? ["content-quarantined"] : []);
          expect((await readGalatsaSnapshot(written.bytes)).snapshot, where).toEqual(
            expected,
          );
          // Saving what was read gives the same document again.
          const again = await readGalatsaFile(writeGalatsaFile(read.doc, none).bytes);
          expect(again.snapshot, where).toEqual(expected);
        }
        expect(toSnapshot(forkDoc(doc, 5)), where).toEqual(expected);
      }
    },
    Math.max(30_000, SEEDS * 2000),
  );
});
