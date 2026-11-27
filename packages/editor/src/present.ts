// SPDX-License-Identifier: GPL-3.0-or-later

// Presenting the document that is open in the editor: the player
// (@galatsa/player) is started over the page, on the editor's live document.
// The editor adds nothing of its own to the presentation; a player of a file
// is the same code over a snapshot. The player reads the document through
// the live resolver and is told what changed, so the presentation follows
// edits made while it runs (someone else's, later). See
// docs/adr/0015-presentation.md.

import { Problems, envelopeField, type ElementId } from "@galatsa/core";
import { roots, stopsAndRoutesOf } from "@galatsa/core/ydoc";
import type { PresentationRequest } from "@galatsa/extension-api/editing";
import type { I18n } from "@galatsa/i18n";
import { mountPlayer, type MountedPlayer } from "@galatsa/player";
import type { Editor, Presenter } from "./editor.ts";

/**
 * Starts the player on the editor's document, in `parent` (over everything
 * else in the page), in full screen where the browser allows it. It starts
 * at the given step of the given route, or, when the document has no stops,
 * with what the editor shows.
 */
export function presentEditor(
  editor: Editor,
  parent: HTMLElement,
  i18n: I18n,
  request: PresentationRequest,
  ended: () => void,
): MountedPlayer {
  const doc = editor.doc;
  return mountPlayer(parent, {
    host: editor.host,
    i18n,
    source: {
      stopsAndRoutes: () => stopsAndRoutesOf(doc),
      resolver: editor.live,
      nameOf(id) {
        const record = roots(doc).elements.get(id);
        if (record === undefined || typeof record.get !== "function") return "";
        return envelopeField.name(record.get("name"), new Problems(0));
      },
    },
    scene: editor.scene,
    ...editor.viewing,
    watch(changed) {
      // One report per change of the document: the elements the live resolver
      // names, and, since stops and routes are not elements, every update.
      let pending: Set<ElementId> | null = null;
      let stopped = false;
      const note = (ids: Iterable<ElementId>): void => {
        if (pending === null) {
          const collected = new Set<ElementId>();
          pending = collected;
          queueMicrotask(() => {
            pending = null;
            if (!stopped) changed(collected);
          });
        }
        for (const id of ids) pending.add(id);
      };
      const stopElements = editor.live.subscribe((changes) =>
        note([...changes.added, ...changes.changed, ...changes.removed]),
      );
      const update = (): void => note([]);
      doc.on("update", update);
      return () => {
        stopped = true;
        stopElements();
        doc.off("update", update);
      };
    },
    ...(request.route !== undefined ? { route: request.route } : {}),
    ...(request.step !== undefined ? { step: request.step } : {}),
    view: editor.camera,
    fullscreen: true,
    mac: editor.platform.mac,
    onExit: ended,
  });
}

/** A presenter for `Editor.setPresenter`: presents in `parent`. */
export function editorPresenter(
  editor: Editor,
  parent: HTMLElement,
  i18n: I18n,
): Presenter {
  return (request, ended) => presentEditor(editor, parent, i18n, request, ended);
}
