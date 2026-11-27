<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  The name of the selected frame, to change it: Enter or Save runs the basics'
  "rename" (one undo step) and closes the panel; Escape or Cancel closes it
  without a change. The canvas gets the keyboard back either way. See
  docs/adr/0014-stacking-and-frames.md.
-->
<script lang="ts">
  import { BASICS, MAX_NAME_LENGTH, elementName } from "@galatsa/extension-basics";
  import { RENAME_PANEL, frameToRename } from "../rename-target.ts";
  import type { PanelProps } from "./panels.ts";
  import { translator } from "./reactive.ts";

  let { context, i18n, focusCanvas }: PanelProps = $props();

  const t = $derived(translator(i18n));
  const uid = $props.id();

  // Read again on every change of the document (another user's rename).
  let version = $state(0);
  $effect(() => {
    const doc = context.doc;
    const bump = (): void => {
      version++;
    };
    doc.on("update", bump);
    return () => doc.off("update", bump);
  });

  const target = $derived(frameToRename(context));
  const current = $derived.by(() => {
    void version;
    return target === null ? "" : elementName(context.doc, target);
  });

  function close(): void {
    context.services.panels.close(RENAME_PANEL);
    focusCanvas();
  }

  function save(draft: string): void {
    if (target !== null && draft !== current) {
      try {
        context.run(BASICS.rename, { id: target, name: draft });
      } catch (error) {
        console.error(error);
      }
    }
    close();
  }

  function keydown(event: KeyboardEvent): void {
    const input = event.currentTarget as HTMLInputElement;
    if (event.key === "Enter") {
      event.preventDefault();
      save(input.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  function focusOnMount(node: HTMLInputElement): void {
    node.focus();
    node.select();
  }
</script>

<div class="panel">
  {#if target === null}
    <p>{t("editor:frames.none")}</p>
    <div class="buttons">
      <button type="button" onclick={close}>{t("common:action.close")}</button>
    </div>
  {:else}
    {#key target}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          const field = event.currentTarget.elements.namedItem("name");
          save(field instanceof HTMLInputElement ? field.value : current);
        }}
      >
        <label for="{uid}-name">{t("editor:frames.name")}</label>
        <input
          id="{uid}-name"
          name="name"
          type="text"
          maxlength={MAX_NAME_LENGTH}
          value={current}
          placeholder={t("galatsa.select:frame.unnamed")}
          onkeydown={keydown}
          use:focusOnMount
        />
        <div class="buttons">
          <button type="submit">{t("editor:frames.save")}</button>
          <button type="button" onclick={close}>{t("common:action.cancel")}</button>
        </div>
      </form>
    {/key}
  {/if}
</div>

<style>
  .panel {
    padding: 10px 12px;
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  input {
    font: inherit;
    padding: 4px 6px;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
  }
  .buttons {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  p {
    margin: 0 0 6px;
  }
</style>
