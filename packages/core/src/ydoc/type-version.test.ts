// SPDX-License-Identifier: GPL-3.0-or-later

// setTypeVersion: an extension upgrades an element's data layout together with a
// user's edit (section 9.4 of docs/adr/0001-document-model-and-file-format.md).

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { FRAME_TYPE, InvalidDocumentError } from "../model/index.ts";
import {
  addElement,
  edit,
  initDocument,
  setData,
  setTypeVersion,
} from "./ops.ts";
import { toSnapshot } from "./snapshot.ts";
import { createUndoManager } from "./track.ts";

const TYPE = "galatsa.test/thing";

function setup(): { doc: Y.Doc; id: string } {
  const doc = new Y.Doc();
  initDocument(doc);
  const id = addElement(doc, {
    type: TYPE,
    typeVersion: 1,
    x: 0,
    y: 0,
    size: { w: 10, h: 10 },
    data: { a: 1 },
  });
  return { doc, id };
}

describe("setTypeVersion", () => {
  it("raises the version together with data in one transaction and one undo step", () => {
    const { doc, id } = setup();
    const undo = createUndoManager(doc);
    let transactions = 0;
    const count = (): void => {
      transactions += 1;
    };
    doc.on("afterTransaction", count);
    edit(doc, () => {
      setData(doc, id, "b", 2);
      setTypeVersion(doc, id, 2);
    });
    doc.off("afterTransaction", count);
    // The edit itself, plus the work tracker's follow-up transaction.
    expect(transactions).toBeLessThanOrEqual(2);
    const after = toSnapshot(doc).elements[id]!;
    expect(after.typeVersion).toBe(2);
    expect(after.data).toEqual({ a: 1, b: 2 });

    undo.undo();
    const before = toSnapshot(doc).elements[id]!;
    expect(before.typeVersion).toBe(1);
    expect(before.data).toEqual({ a: 1 });
  });

  it("refuses to lower the version, and values that are not versions", () => {
    const { doc, id } = setup();
    setTypeVersion(doc, id, 3);
    expect(() => setTypeVersion(doc, id, 2)).toThrow(InvalidDocumentError);
    expect(() => setTypeVersion(doc, id, 0)).toThrow(InvalidDocumentError);
    expect(() => setTypeVersion(doc, id, 1.5)).toThrow(InvalidDocumentError);
    expect(toSnapshot(doc).elements[id]!.typeVersion).toBe(3);
  });

  it("refuses frames and groups", () => {
    const { doc } = setup();
    const frame = addElement(doc, { type: FRAME_TYPE, x: 0, y: 0, size: { w: 1, h: 1 } });
    expect(() => setTypeVersion(doc, frame, 2)).toThrow(InvalidDocumentError);
  });
});
