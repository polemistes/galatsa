<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  The canvas's context menu (context-menu.ts): opens where the right click
  was, keeps inside the canvas, and closes on Escape, a click elsewhere, the
  wheel or leaving the window. Arrow keys move between the entries.
-->
<script lang="ts">
  import type { MenuEntry } from "../context-menu.ts";
  import type { Editor } from "../editor.ts";
  import { translator, Watched } from "./reactive.ts";

  let { editor }: { editor: Editor } = $props();

  const t = $derived(translator(editor.i18n));
  const menu = $derived(editor.contextMenu);
  const watched = $derived(new Watched(menu, () => menu.state));
  const current = $derived(watched.current);

  let element: HTMLElement | undefined = $state();
  let place = $state({ left: 0, top: 0 });

  /** The entries with a separator before each new group. */
  const rows = $derived(
    (current?.entries ?? []).map(
      (entry: MenuEntry, i: number, all: readonly MenuEntry[]) => ({
        entry,
        separated: i > 0 && all[i - 1]!.group !== entry.group,
      }),
    ),
  );

  // Keep the menu inside the canvas, and give the first entry the keys.
  $effect(() => {
    if (current === null || element === undefined) return;
    const parent = element.offsetParent as HTMLElement | null;
    const width = parent?.clientWidth ?? Infinity;
    const height = parent?.clientHeight ?? Infinity;
    // The menu's place is given on the canvas, which lies beside the
    // toolbar and the properties (docs/adr/0016).
    const style = parent === null ? null : getComputedStyle(parent);
    const left = parseFloat(style?.getPropertyValue("--galatsa-stage-left") ?? "") || 0;
    const top = parseFloat(style?.getPropertyValue("--galatsa-stage-top") ?? "") || 0;
    place = {
      left: Math.max(left, Math.min(current.x + left, width - element.offsetWidth - 4)),
      top: Math.max(top, Math.min(current.y + top, height - element.offsetHeight - 4)),
    };
    element.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  });

  // Close on a press elsewhere, the wheel, or when the window loses focus.
  $effect(() => {
    if (current === null) return;
    const outside = (event: Event): void => {
      if (element !== undefined && !element.contains(event.target as Node)) menu.close();
    };
    const close = (): void => menu.close();
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("blur", close);
    };
  });

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      menu.close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [
      ...(element?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []),
    ];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length]!.focus();
  }
</script>

{#if current !== null}
  <div
    bind:this={element}
    class="galatsa-context-menu"
    role="menu"
    tabindex="-1"
    aria-label={t("editor:menu.label")}
    style:left="{place.left}px"
    style:top="{place.top}px"
    onkeydown={keydown}
    oncontextmenu={(event) => event.preventDefault()}
  >
    {#each rows as { entry, separated } (entry.key)}
      {#if separated}
        <hr />
      {/if}
      <button
        type="button"
        role="menuitem"
        data-key={entry.key}
        disabled={!entry.enabled}
        onclick={() => menu.choose(entry)}>{t(entry.label)}</button
      >
    {/each}
  </div>
{/if}

<style>
  div {
    position: absolute;
    min-width: 12rem;
    padding: 4px 0;
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.16);
    pointer-events: auto;
    outline: none;
  }
  button {
    display: block;
    width: 100%;
    padding: 4px 16px;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    text-align: start;
    cursor: default;
  }
  button:hover:not([disabled]),
  button:focus-visible {
    background: #e0e7ff;
    outline: none;
  }
  button[disabled] {
    color: #94a3b8;
  }
  hr {
    margin: 4px 0;
    border: 0;
    border-top: 1px solid #e2e8f0;
  }
</style>
