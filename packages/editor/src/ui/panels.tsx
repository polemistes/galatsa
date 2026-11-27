// SPDX-License-Identifier: GPL-3.0-or-later

// The React binding for custom panels (docs/adr/0005, section 8): a panel may
// bring its own view as a React component. Panels of fields are drawn by the
// editor's field renderer, which comes with the editor shell; until then they
// are not shown.

import type { CommandContext } from "@galatsa/extension-api/editing";
import type { ComponentType } from "react";
import type { Editor } from "../editor.ts";
import { useI18n, useStore } from "./hooks.ts";

/** What a custom panel's React view gets. */
export interface PanelProps {
  /** The command context of the editor's document now (services, history, run). */
  readonly context: CommandContext;
}

declare module "@galatsa/extension-api/editing" {
  interface CustomPanelViews {
    /** A React component, for panels that need an interface of their own. */
    readonly react?: ComponentType<PanelProps>;
  }
}

/** The open panels whose view is a React component. */
export function Panels({ editor }: { readonly editor: Editor }) {
  const i18n = useI18n(editor.i18n);
  useStore(editor, () => editor.version);
  const env = editor.environment();
  const context = editor.host.commands.context(env);
  const open = editor.host
    .panels(editor.mode)
    .filter((panel) => editor.services.panels.isOpen(panel.id))
    .filter((panel) => {
      try {
        return panel.definition.visible?.(context) ?? true;
      } catch {
        return false;
      }
    });
  if (open.length === 0) return null;
  return (
    <aside className="galatsa-panels" aria-label={i18n.t("editor:panels.label")}>
      {open.map((panel) => {
        const content = panel.definition.content;
        if (content.kind !== "custom" || content.binding !== "react") return null;
        const View = content.view;
        return (
          <section key={panel.id} aria-label={i18n.t(panel.definition.label)}>
            <View context={context} />
          </section>
        );
      })}
    </aside>
  );
}
