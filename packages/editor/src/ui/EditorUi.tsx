// SPDX-License-Identifier: GPL-3.0-or-later

// The React root of the editor: what is drawn over the canvas. For now the
// save status and the storage layer's notices, saving as a file and closing
// with the offer to save first, the recovery offers at start
// (docs/adr/0006, section 7.1), extensions that were not loaded, shortcut
// conflicts, and open custom panels. Toolbars and the properties panel come
// with the editor shell.

import { problemMessage } from "@galatsa/extension-api/editing";
import type { I18n } from "@galatsa/i18n";
import { noticeText, type RecoveryOffer, type SessionStatus } from "@galatsa/storage";
import { useState, type CSSProperties, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { AppState, EditorApp } from "../app.ts";
import type { DocumentState, EditorDocument } from "../document.ts";
import { useI18n, useStore } from "./hooks.ts";
import { Panels } from "./panels.tsx";

const layer: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  font: "14px/1.4 system-ui, sans-serif",
  color: "#1e293b",
};

const bar: CSSProperties = {
  position: "absolute",
  left: 8,
  bottom: 8,
  maxWidth: "calc(100% - 16px)",
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
  padding: "6px 10px",
  background: "rgba(255, 255, 255, 0.92)",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  pointerEvents: "auto",
};

const stack: CSSProperties = {
  position: "absolute",
  left: 8,
  top: 8,
  maxWidth: "min(36rem, calc(100% - 16px))",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  pointerEvents: "auto",
};

const card: CSSProperties = {
  padding: "8px 12px",
  background: "#fff",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.12)",
};

const dialogBackdrop: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeItems: "center",
  background: "rgba(15, 23, 42, 0.25)",
  pointerEvents: "auto",
};

const dialog: CSSProperties = {
  ...card,
  maxWidth: "min(32rem, calc(100% - 32px))",
  padding: "16px 20px",
};

const buttons: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 12,
};

function Dialog({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div style={dialogBackdrop}>
      <div role="dialog" aria-modal="true" aria-label={label} style={dialog}>
        {children}
      </div>
    </div>
  );
}

/** The save status in words (the storage layer's texts). */
function statusText(
  i18n: I18n,
  status: SessionStatus,
  state: DocumentState,
): string | null {
  if (state.phase === "closing") return i18n.t("editor:status.closing");
  if (state.savingFile) return i18n.t("editor:status.savingFile");
  if (status.problem !== null) return i18n.t("storage:status.failed");
  if (status.saving || status.pending) return i18n.t("storage:status.saving");
  if (status.unsavedToFile && status.fileName !== null)
    return i18n.t("storage:status.unsavedToFile");
  if (status.lastStoredAt !== null)
    return i18n.t("storage:status.saved", { when: status.lastStoredAt });
  return null;
}

function DocumentBar({
  i18n,
  doc,
}: {
  readonly i18n: I18n;
  readonly doc: EditorDocument;
}) {
  const state = useStore(doc, () => doc.state);
  const status = state.status;
  const text = statusText(i18n, status, state);
  const busy = state.phase !== "open" || state.savingFile;
  return (
    <>
      <div style={stack}>
        {status.problem !== null && (
          <div role="alert" style={card}>
            {noticeText(i18n, status.problem)}
          </div>
        )}
        {state.notices.map((notice, index) => (
          <div
            key={`${index}-${notice.code}`}
            role={notice.severity === "error" ? "alert" : "status"}
            style={card}
          >
            {noticeText(i18n, notice)}{" "}
            <button type="button" onClick={() => doc.dismissNotice(index)}>
              {i18n.t("editor:action.dismissNotice")}
            </button>
          </div>
        ))}
      </div>
      <div style={bar}>
        <span role="status" className="galatsa-save-status">
          {text}
        </span>
        <button type="button" disabled={busy} onClick={() => void doc.saveAsFile()}>
          {i18n.t("editor:action.saveAsFile")}
        </button>
        <button type="button" disabled={busy} onClick={() => void doc.close()}>
          {i18n.t("editor:action.close")}
        </button>
      </div>
      {state.phase === "offer-save" && (
        <Dialog label={i18n.t("editor:close.heading")}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{i18n.t("editor:close.heading")}</h2>
          <p>{i18n.t("editor:close.detail")}</p>
          <div style={buttons}>
            <button
              type="button"
              disabled={state.savingFile}
              onClick={() =>
                void doc.saveAsFile().then((result) => {
                  // Saved: the file holds everything, so the document can go.
                  if (result?.ok) void doc.closeAnyway();
                })
              }
            >
              {i18n.t("editor:action.saveAsFile")}
            </button>
            <button type="button" onClick={() => void doc.closeAnyway()}>
              {i18n.t("editor:close.anyway")}
            </button>
            <button type="button" onClick={() => doc.keepOpen()}>
              {i18n.t("editor:close.keepOpen")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function RecoveryDialog({
  i18n,
  app,
  offer,
  state,
}: {
  readonly i18n: I18n;
  readonly app: EditorApp;
  readonly offer: RecoveryOffer;
  readonly state: AppState;
}) {
  const [confirm, setConfirm] = useState<"discard" | "delete" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const title =
    offer.title.trim() !== "" ? offer.title : i18n.t("storage:recovery.untitled");
  const savedToFile = offer.savedToFileAt !== null && offer.fileName !== null;
  return (
    <Dialog label={i18n.t("storage:recovery.heading")}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{i18n.t("storage:recovery.heading")}</h2>
      <p>{i18n.t("storage:recovery.offer", { title, when: offer.changedAt })}</p>
      {state.problem !== null && <p role="alert">{noticeText(i18n, state.problem)}</p>}
      {message !== null && <p role="alert">{message}</p>}
      {confirm === "discard" && (
        <p>
          {i18n.t("storage:recovery.discardChanges.detail", {
            name: offer.fileName ?? "",
            when: offer.savedToFileAt ?? 0,
          })}
        </p>
      )}
      {confirm === "delete" && (
        <p>{i18n.t("storage:recovery.delete.detail", { title })}</p>
      )}
      <div style={buttons}>
        <button type="button" onClick={() => void app.restore(offer.slot)}>
          {i18n.t("storage:recovery.restore")}
        </button>
        <button type="button" onClick={() => void app.later(offer.slot)}>
          {i18n.t("storage:recovery.later")}
        </button>
        <button
          type="button"
          title={i18n.t("storage:recovery.dismiss.detail", { title })}
          onClick={() => void app.dismiss(offer.slot)}
        >
          {i18n.t("storage:recovery.dismiss")}
        </button>
        {savedToFile &&
          (confirm === "discard" ? (
            <button
              type="button"
              onClick={() =>
                void app.discard(offer.slot).then((result) => {
                  if (result === null)
                    setMessage(i18n.t("editor:recovery.discardNoFile"));
                  else if (!result.ok && result.reason === "file-failed")
                    setMessage(noticeText(i18n, result.problem));
                })
              }
            >
              {i18n.t("editor:recovery.discardConfirm")}
            </button>
          ) : (
            <button type="button" onClick={() => setConfirm("discard")}>
              {i18n.t("storage:recovery.discardChanges")}
            </button>
          ))}
        {!savedToFile &&
          (confirm === "delete" ? (
            <button type="button" onClick={() => void app.deleteOffer(offer.slot)}>
              {i18n.t("editor:recovery.deleteConfirm")}
            </button>
          ) : (
            <button type="button" onClick={() => setConfirm("delete")}>
              {i18n.t("storage:recovery.delete")}
            </button>
          ))}
      </div>
    </Dialog>
  );
}

function Problems({ i18n, state }: { readonly i18n: I18n; readonly state: AppState }) {
  if (state.problems.length === 0 && state.conflicts.length === 0) return null;
  return (
    <details
      style={{ ...card, position: "absolute", right: 8, top: 8, pointerEvents: "auto" }}
    >
      <summary>{i18n.t("editor:problems.heading")}</summary>
      <ul>
        {state.problems.map((problem) => {
          const { label, values } = problemMessage(problem);
          return <li key={`p-${problem.extension}`}>{i18n.t(label, values)}</li>;
        })}
        {state.conflicts.map((c) => (
          <li key={`c-${c.shortcut}-${c.ignored}`}>
            {i18n.t("extensions:problem.shortcut-conflict", {
              shortcut: c.shortcut,
              ignored: c.ignored,
            })}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function EditorUi({ app }: { readonly app: EditorApp }) {
  const i18n = useI18n(app.i18n);
  const state = useStore(app, () => app.state);
  const offer = state.phase === "recovery" ? state.offers[0] : undefined;
  return (
    <div style={layer}>
      {state.noStorage && (
        <div role="alert" style={{ ...card, position: "absolute", right: 8, bottom: 8 }}>
          {i18n.t("editor:status.noStorage")}
        </div>
      )}
      {(state.phase === "starting" || state.phase === "opening") && (
        <div role="status" style={{ ...card, position: "absolute", left: 8, top: 8 }}>
          {i18n.t("editor:status.opening")}
        </div>
      )}
      {state.phase === "failed" && state.problem !== null && (
        <div role="alert" style={{ ...card, position: "absolute", left: 8, top: 8 }}>
          {noticeText(i18n, state.problem)}
        </div>
      )}
      {state.phase === "closed" && (
        <div role="status" style={{ ...card, position: "absolute", left: 8, top: 8 }}>
          {i18n.t("editor:status.closed")}
        </div>
      )}
      {state.phase === "editing" && state.document !== null && (
        <DocumentBar i18n={i18n} doc={state.document} />
      )}
      {state.editor !== null && <Panels editor={state.editor} />}
      {offer !== undefined && (
        <RecoveryDialog
          key={offer.slot}
          i18n={i18n}
          app={app}
          offer={offer}
          state={state}
        />
      )}
      <Problems i18n={i18n} state={state} />
    </div>
  );
}

/** Draws the editor's React root into `container`; returns how to remove it. */
export function renderEditorUi(app: EditorApp, container: HTMLElement): () => void {
  const root = createRoot(container);
  root.render(<EditorUi app={app} />);
  return () => root.unmount();
}
