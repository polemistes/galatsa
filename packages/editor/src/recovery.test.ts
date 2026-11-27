// SPDX-License-Identifier: GPL-3.0-or-later

// "Discard the changes" accepts only the file of the same presentation.

import { initDocument } from "@galatsa/core/ydoc";
import { writeGalatsaFile } from "@galatsa/format";
import { memoryFile } from "@galatsa/storage";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { checkDiscardFile } from "./recovery.ts";

function fileOf(id: string, name: string) {
  const doc = new Y.Doc();
  initDocument(doc, { id });
  const bytes = writeGalatsaFile(doc, () => undefined).bytes;
  return memoryFile(name, bytes);
}

describe("checkDiscardFile", () => {
  it("accepts the same presentation, by its document id, whatever the file is called", async () => {
    const check = await checkDiscardFile(
      { documentId: "talk-1", fileName: "talk.galatsa" },
      fileOf("talk-1", "renamed.galatsa"),
    );
    expect(check.ok).toBe(true);
    // The bytes are read once and handed on.
    if (check.ok) expect((await check.file.read()).length).toBeGreaterThan(0);
  });

  it("refuses another presentation before anything is discarded", async () => {
    const check = await checkDiscardFile(
      { documentId: "talk-1", fileName: "talk.galatsa" },
      fileOf("holiday-2", "talk.galatsa"),
    );
    expect(check).toEqual({ ok: false, reason: "other-document", name: "talk.galatsa" });
  });

  it("without a known document id, needs the name the presentation was saved under", async () => {
    const offer = { documentId: "unknown", fileName: "talk.galatsa" };
    expect((await checkDiscardFile(offer, fileOf("a", "talk.galatsa"))).ok).toBe(true);
    expect((await checkDiscardFile(offer, fileOf("a", "other.galatsa"))).ok).toBe(false);
  });

  it("passes on a file that cannot be read, so opening it fails and nothing is discarded", async () => {
    const broken = memoryFile("talk.galatsa", new Uint8Array([1, 2, 3]));
    expect(
      (await checkDiscardFile({ documentId: "talk-1", fileName: null }, broken)).ok,
    ).toBe(true);
  });
});
