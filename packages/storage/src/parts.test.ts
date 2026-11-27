// SPDX-License-Identifier: GPL-3.0-or-later

import { FileFormatError } from "@galatsa/format";
import { createI18n } from "@galatsa/i18n";
import { initDocument } from "@galatsa/core/ydoc";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { StorageError, checkKey } from "./backend.ts";
import { encodeCheckpointFile } from "./checkpoint.ts";
import { FRAME_KIND, decodeFrame, encodeFrame } from "./frame.ts";
import { createMemoryStore } from "./memory.ts";
import en from "./messages/en.ts";
import { storageMessages } from "./messages/index.ts";
import {
  autosaveProblem,
  fileNotices,
  notice,
  noticeText,
  openProblem,
  saveProblem,
  type NoticeCode,
} from "./notices.ts";
import { checkBackendContract } from "./testing.ts";
import { serveCheckpoints, workerEncoder } from "./worker.ts";

describe("the checkpoint worker protocol", () => {
  it("builds the same checkpoint as this thread, and falls back when the worker fails", async () => {
    const doc = new Y.Doc();
    initDocument(doc, { title: "In a worker" });
    const state = Y.encodeStateAsUpdate(doc);
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();
    serveCheckpoints(channel.port2);
    const encoder = workerEncoder(channel.port1);
    const remote = await encoder(state);
    const local = encodeCheckpointFile(state);
    expect([...remote.file]).toEqual([...local.file]);
    expect(remote.keepState).toBe(false);
    channel.port1.close();
    channel.port2.close();

    // A worker that reports an error instead of answering: done on this thread.
    let onError: ((event: Event) => void) | null = null;
    const dead = workerEncoder({
      postMessage() {
        queueMicrotask(() => onError?.(new Event("error")));
      },
      addEventListener(type: string, listener: (event: never) => void) {
        if (type === "error") onError = listener as (event: Event) => void;
      },
    });
    expect([...(await dead(state)).file]).toEqual([...local.file]);
  });
});

describe("the memory backend", () => {
  it("keeps the backend contract", async () => {
    await checkBackendContract(createMemoryStore().backend());
  });

  it("stops writing when killed, and tears a write when asked", async () => {
    const store = createMemoryStore();
    const a = store.backend();
    const b = store.backend();
    await a.write("k", new Uint8Array([1, 2, 3]));
    a.kill();
    await expect(a.write("k", new Uint8Array([9]))).rejects.toBeInstanceOf(StorageError);
    expect([...(await b.read("k"))!]).toEqual([1, 2, 3]);
    store.tearNextWrite(2);
    await expect(b.write("t", new Uint8Array([4, 5, 6, 7]))).rejects.toThrow();
    expect([...store.data.get("t")!]).toEqual([4, 5]);
    expect(b.killed).toBe(true);
  });

  it("refuses keys a file system could not hold", () => {
    for (const bad of ["", "A", "a//b", "../x", "a/../b", "a b", "/a", "a/"]) {
      expect(() => checkKey(bad), bad).toThrow(StorageError);
    }
    checkKey("doc/abc/j/s1-00000001");
    checkKey("doc/abc/a/sha256-0123abcdef");
  });
});

describe("frames", () => {
  it("read back only when whole and intact", () => {
    const payload = new Uint8Array(300).map((_, i) => i * 7);
    const bytes = encodeFrame(FRAME_KIND.journal, { seq: 3 }, payload);
    const frame = decodeFrame(bytes, FRAME_KIND.journal);
    expect(frame?.header).toEqual({ seq: 3 });
    expect([...frame!.payload]).toEqual([...payload]);
    expect(decodeFrame(bytes, FRAME_KIND.checkpoint)).toBeNull();
    for (let cut = 0; cut < bytes.length; cut++) {
      expect(
        decodeFrame(bytes.subarray(0, cut), FRAME_KIND.journal),
        `cut ${cut}`,
      ).toBeNull();
    }
    for (let i = 0; i < bytes.length; i += 3) {
      const damaged = bytes.slice();
      damaged[i]! ^= 0x10;
      expect(decodeFrame(damaged, FRAME_KIND.journal), `byte ${i}`).toBeNull();
    }
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    expect(decodeFrame(longer, FRAME_KIND.journal)).toBeNull();
  });
});

describe("notices", () => {
  const codes = Object.keys(en)
    .filter((key) => key.startsWith("notice."))
    .map((key) => key.slice("notice.".length) as NoticeCode);

  it("have a message in both languages, with every value filled in", () => {
    const warnings: string[] = [];
    for (const locale of ["nb", "en"] as const) {
      const i18n = createI18n({ dev: true, locale, warn: (w) => warnings.push(w) });
      for (const code of codes) {
        const text = noticeText(
          i18n,
          notice(code, { count: 2, name: "a.galatsa", when: 0 }),
        );
        expect(text, `${locale} ${code}`).not.toMatch(/⟦|\{/);
        expect(text.length, `${locale} ${code}`).toBeGreaterThan(10);
      }
      const t = i18n.translator(storageMessages);
      expect(t("status.saved", { when: Date.UTC(2026, 10, 27, 12, 30) })).not.toMatch(
        /⟦/,
      );
    }
    expect(warnings).toEqual([]);
  });

  it("say why a file was refused or not saved", () => {
    const cases: [FileFormatError["code"], NoticeCode][] = [
      ["not-zip", "file-not-galatsa"],
      ["not-galatsa", "file-not-galatsa"],
      ["damaged", "file-damaged"],
      ["newer-version", "file-newer-version"],
      ["too-large", "file-too-large"],
      ["unsupported", "file-unsupported"],
    ];
    for (const [code, expected] of cases) {
      expect(openProblem(new FileFormatError(code, "x"), "f").code).toBe(expected);
    }
    expect(openProblem(new Error("io")).code).toBe("file-unreadable");
    expect(saveProblem(new FileFormatError("too-large", "x")).code).toBe(
      "save-too-large",
    );
    expect(saveProblem(new Error("io")).code).toBe("save-failed");
    expect(autosaveProblem(new StorageError("full", "x")).code).toBe("storage-full");
    expect(autosaveProblem({ name: "QuotaExceededError" }).code).toBe("storage-full");
    expect(autosaveProblem(new Error("x")).code).toBe("autosave-failed");
  });

  it("summarise file warnings by kind", () => {
    const notices = fileNotices([
      { code: "asset-missing", message: "" },
      { code: "asset-missing", message: "" },
      { code: "migrated", message: "" },
      { code: "thumbnail-missing", message: "" },
      { code: "previews-not-written", message: "" },
    ]);
    expect(notices.map((n) => [n.code, n.values?.["count"]])).toEqual([
      ["file-upgraded", undefined],
      ["merge-identity-lost", undefined],
      ["assets-missing", 2],
      ["save-without-previews", undefined],
    ]);
  });
});
