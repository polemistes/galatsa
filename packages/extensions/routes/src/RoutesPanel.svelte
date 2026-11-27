<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  The routes panel: choose, add, rename and delete routes; see the stops of a
  route in order, choose one and jump to it, move it up or down, add stops
  from the view, from selected frames or from another route (a shared stop);
  and for the chosen stop its name, what it shows and hides on arrival, its
  notes, and removing it from the route or deleting it, with a warning when
  routes use it. Every change runs a command (one undo step each). The strip
  of thumbnails is the editor shell's. See docs/adr/0013-routes-and-stops.md.
-->
<script lang="ts">
  import type { RouteEntryId, StopId } from "@galatsa/core";
  // Types only: the editor's Svelte binding for custom panels.
  import type { PanelProps } from "@galatsa/editor";
  import { untrack } from "svelte";
  import {
    ROUTES,
    ROUTES_COMMANDS,
    ROUTES_PANEL,
    routesCommandEnabled,
  } from "./commands.ts";
  import DraftField from "./DraftField.svelte";
  import {
    elementName,
    firstPlaces,
    isLiveStop,
    liveRoutes,
    liveStops,
    readRoutes,
    routeSteps,
    routesUsing,
    type StopsAndRoutes,
  } from "./model.ts";
  import { choose, currentChoice, watchChoice } from "./state.ts";
  import { translator } from "./translate.ts";

  let { context, i18n, focusCanvas }: PanelProps = $props();

  const t = $derived(translator(i18n));
  const doc = $derived(context.doc);
  const uid = $props.id();

  // Read again on every change of the document or of the choice.
  let version = $state(0);
  $effect(() => {
    const watched = doc;
    const bump = (): void => {
      version++;
    };
    watched.on("update", bump);
    // The services are the editor's, the same in every context it passes.
    const overlays = untrack(() => context.services.overlays);
    const stop = watchChoice(watched, () => {
      bump();
      // The route line shows the chosen route and step.
      overlays.invalidate();
    });
    return () => {
      watched.off("update", bump);
      stop();
    };
  });

  /** The stop's name, the name of its frame, or its place in a route. */
  function stopLabel(sr: StopsAndRoutes, stop: StopId, position: number): string {
    const record = sr.stops[stop];
    if (record === undefined) return "";
    if (record.name !== "") return record.name;
    if (record.view.kind === "frame") {
      const name = elementName(doc, record.view.frame);
      if (name !== "") return name;
    }
    return position > 0
      ? t("galatsa.routes:stop.untitled", { n: position })
      : t("galatsa.routes:stop.unused");
  }

  const model = $derived.by(() => {
    void version;
    const sr = readRoutes(doc);
    const choice = currentChoice(doc, sr);
    const routes = liveRoutes(sr).map((id, i) => ({
      id,
      label: sr.routes[id]!.name || t("galatsa.routes:route.untitled", { n: i + 1 }),
      name: sr.routes[id]!.name,
    }));
    const steps =
      choice.route === null
        ? []
        : routeSteps(sr, choice.route).map((step, i) => ({
            ...step,
            label: stopLabel(sr, step.stop, i + 1),
          }));
    const chosenIndex = steps.findIndex((step) => step.entry === choice.entry);
    const chosen = chosenIndex < 0 ? null : steps[chosenIndex]!;
    const stop = chosen === null ? null : sr.stops[chosen.stop]!;
    // A stop is numbered by its first place in any route.
    const firstPlace = firstPlaces(sr);
    const existing = liveStops(sr).map((id) => ({
      id,
      label: stopLabel(sr, id, firstPlace.get(id) ?? 0),
    }));
    const usedIn = chosen === null ? 0 : routesUsing(sr, chosen.stop).length;
    let visits = 0;
    if (chosen !== null)
      for (const route of liveRoutes(sr))
        for (const s of routeSteps(sr, route)) if (s.stop === chosen.stop) visits++;
    const visibility =
      stop === null
        ? []
        : Object.entries(stop.visibility).map(([id, change]) => ({
            id,
            action: change.action,
            label: elementName(doc, id) || t("galatsa.routes:element.untitled"),
          }));
    const notes =
      stop === null
        ? ""
        : stop.notes.delta
            .map((run) => (typeof run.insert === "string" ? run.insert : ""))
            .join("");
    return {
      route: choice.route,
      routeName: routes.find((r) => r.id === choice.route)?.name ?? "",
      routes,
      steps,
      chosenIndex,
      chosen,
      stop,
      existing,
      usedIn,
      visits,
      visibility,
      notes,
    };
  });

  /** Whether a command would run now with these arguments (to grey out a button). */
  function can(id: string, args?: unknown): boolean {
    void version;
    void context;
    return routesCommandEnabled(context, id, args);
  }

  /**
   * Runs a command. One that cannot run, or fails, is told to the user in the
   * editor's notice, never passed over in silence.
   */
  function run(id: string, args?: unknown): void {
    try {
      context.run(id, args);
    } catch (error) {
      console.error(error);
      const label = ROUTES_COMMANDS.get(id)?.label;
      context.services.notices.show("galatsa.routes:failed", {
        action: label === undefined ? id : i18n.t(label),
      });
    }
  }

  /**
   * After an action with a button or a list (not typing in a text field),
   * the canvas gets the keyboard back, so undo and its other keys work at
   * once (docs/adr/0013).
   */
  function act(action: () => void): () => void {
    return () => {
      action();
      focusCanvas();
    };
  }

  let existingStop = $state<string>("");
  let deleting = $state<StopId | null>(null);
  let dialog = $state<HTMLElement | null>(null);

  /** How many routes use the stop being deleted, now: it follows other users' changes. */
  const deletingCount = $derived.by(() => {
    void version;
    return deleting === null ? 0 : routesUsing(readRoutes(doc), deleting).length;
  });

  // A stop deleted meanwhile (by another user, or an undo) needs no question.
  $effect(() => {
    void version;
    if (deleting !== null && !isLiveStop(readRoutes(doc), deleting)) closeDialog();
  });

  function chooseRoute(route: string): void {
    choose(doc, { route, entry: null });
  }

  function goTo(entry: RouteEntryId, stop: StopId): void {
    if (model.route === null) return;
    choose(doc, { route: model.route, entry });
    if (can(ROUTES.goToStop, { stop })) run(ROUTES.goToStop, { stop });
  }

  function move(entry: RouteEntryId, index: number): void {
    if (model.route === null) return;
    run(ROUTES.moveVisit, { route: model.route, entry, index });
  }

  function addExisting(): void {
    if (existingStop === "") return;
    run(
      ROUTES.addVisit,
      model.route === null
        ? { stop: existingStop }
        : { stop: existingStop, route: model.route },
    );
  }

  /** Deleting a stop that routes use asks first (the users' decision, E9). */
  function askDelete(stop: StopId): void {
    if (routesUsing(readRoutes(doc), stop).length === 0) {
      run(ROUTES.deleteStop, { stop });
      focusCanvas();
      return;
    }
    deleting = stop;
  }

  /** Closes the dialog; the canvas gets the keyboard, so Ctrl+Z undoes at once. */
  function closeDialog(): void {
    deleting = null;
    focusCanvas();
  }

  function confirmDelete(): void {
    if (deleting === null) return;
    const stop = deleting;
    run(ROUTES.deleteStop, { stop });
    closeDialog();
  }

  /** The dialog's buttons, in order. */
  function dialogButtons(): HTMLElement[] {
    return dialog === null ? [] : [...dialog.querySelectorAll<HTMLElement>("button")];
  }

  /**
   * While the dialog is open it is modal for the keyboard: Tab and Shift+Tab
   * go round its buttons, Escape closes it wherever the focus is, and no other
   * key reaches the canvas or the panel behind it.
   */
  function windowKey(event: KeyboardEvent): void {
    if (deleting === null) return;
    const buttons = dialogButtons();
    const inside =
      dialog !== null && event.target instanceof Node && dialog.contains(event.target);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeDialog();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      if (buttons.length === 0) return;
      const at = buttons.indexOf(document.activeElement as HTMLElement);
      const step = event.shiftKey ? -1 : 1;
      buttons[(at + step + buttons.length) % buttons.length]!.focus();
      return;
    }
    if (!inside) {
      event.preventDefault();
      event.stopPropagation();
      buttons[0]?.focus();
    }
  }

  /** The focus may not leave the open dialog (a click behind it, a script). */
  function windowFocus(event: FocusEvent): void {
    if (deleting === null || dialog === null) return;
    if (event.target instanceof Node && dialog.contains(event.target)) return;
    dialogButtons()[0]?.focus();
  }

  /**
   * A press on a button keeps the keyboard focus where it is, and a press on
   * the dialog's backdrop keeps it in the dialog; a text field being edited
   * lets it go, so that its change is saved.
   */
  function keepFocus(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.classList.contains("backdrop")) {
      event.preventDefault();
      return;
    }
    if (target.closest("button") === null) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
      return;
    event.preventDefault();
  }

  function focusOnMount(node: HTMLElement): void {
    node.focus();
  }

  const selectionSize = $derived(context.services.selection.get().length);
</script>

<svelte:window onkeydowncapture={windowKey} onfocusin={windowFocus} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="panel" onmousedown={keepFocus}>
  <header>
    <h2 id="{uid}-title">{t("galatsa.routes:panel")}</h2>
    <button
      type="button"
      class="icon"
      aria-label={t("galatsa.routes:close")}
      title={t("galatsa.routes:close")}
      onclick={act(() => context.services.panels.close(ROUTES_PANEL))}>×</button
    >
  </header>

  {#if model.routes.length === 0}
    <p class="hint">{t("galatsa.routes:no-routes")}</p>
  {:else}
    <div class="field">
      <label for="{uid}-route">{t("galatsa.routes:route")}</label>
      <select
        id="{uid}-route"
        value={model.route ?? ""}
        onchange={(e) => {
          chooseRoute(e.currentTarget.value);
          focusCanvas();
        }}
      >
        {#each model.routes as route (route.id)}
          <option value={route.id}>{route.label}</option>
        {/each}
      </select>
    </div>
    {#if model.route !== null}
      {@const route = model.route}
      <div class="field">
        <label for="{uid}-route-name">{t("galatsa.routes:route.name")}</label>
        {#key route}
          <DraftField
            id="{uid}-route-name"
            target={route}
            value={model.routeName}
            oncommit={(id, name) => run(ROUTES.renameRoute, { route: id, name })}
          />
        {/key}
      </div>
    {/if}
  {/if}
  <div class="row">
    <button type="button" onclick={act(() => run(ROUTES.addRoute))}
      >{t("galatsa.routes:add-route")}</button
    >
    {#if model.route !== null}
      {@const route = model.route}
      <button type="button" onclick={act(() => run(ROUTES.deleteRoute, { route }))}
        >{t("galatsa.routes:delete-route")}</button
      >
    {/if}
  </div>

  <h3>{t("galatsa.routes:steps")}</h3>
  {#if model.steps.length === 0}
    <p class="hint">{t("galatsa.routes:no-steps")}</p>
  {:else}
    <ol class="steps" aria-label={t("galatsa.routes:steps")}>
      {#each model.steps as s, i (s.entry)}
        <li class:chosen={i === model.chosenIndex}>
          <button
            type="button"
            class="step"
            aria-current={i === model.chosenIndex ? "step" : undefined}
            onclick={act(() => goTo(s.entry, s.stop))}
          >
            <span class="number">{i + 1}</span>
            <span class="name">{s.label}</span>
          </button>
          <button
            type="button"
            class="icon"
            aria-label={t("galatsa.routes:move-up")}
            title={t("galatsa.routes:move-up")}
            disabled={i === 0}
            onclick={act(() => move(s.entry, i - 1))}>↑</button
          >
          <button
            type="button"
            class="icon"
            aria-label={t("galatsa.routes:move-down")}
            title={t("galatsa.routes:move-down")}
            disabled={i === model.steps.length - 1}
            onclick={act(() => move(s.entry, i + 1))}>↓</button
          >
        </li>
      {/each}
    </ol>
  {/if}
  <div class="row">
    <button type="button" onclick={act(() => run(ROUTES.addStopFromView))}
      >{t("galatsa.routes:add-stop-from-view")}</button
    >
    <button
      type="button"
      disabled={selectionSize === 0 || !can(ROUTES.addStopsFromFrames)}
      onclick={act(() => run(ROUTES.addStopsFromFrames))}
      >{t("galatsa.routes:add-stops-from-frames")}</button
    >
  </div>
  {#if model.existing.length > 0}
    <div class="row">
      <div class="field grow">
        <label for="{uid}-existing">{t("galatsa.routes:existing")}</label>
        <select
          id="{uid}-existing"
          bind:value={existingStop}
          onchange={() => focusCanvas()}
        >
          <option value=""></option>
          {#each model.existing as stop (stop.id)}
            <option value={stop.id}>{stop.label}</option>
          {/each}
        </select>
      </div>
      <button type="button" disabled={existingStop === ""} onclick={act(addExisting)}
        >{t("galatsa.routes:add-visit")}</button
      >
    </div>
  {/if}

  {#if model.chosen !== null && model.stop !== null && model.route !== null}
    {@const chosen = model.chosen}
    {@const route = model.route}
    <section aria-labelledby="{uid}-stop">
      <h3 id="{uid}-stop">{t("galatsa.routes:selected-stop")}</h3>
      <div class="field">
        <label for="{uid}-stop-name">{t("galatsa.routes:stop.name")}</label>
        {#key chosen.stop}
          <DraftField
            id="{uid}-stop-name"
            target={chosen.stop}
            value={model.stop.name}
            oncommit={(stop, name) => run(ROUTES.renameStop, { stop, name })}
          />
        {/key}
      </div>
      <p class="hint">
        {t("galatsa.routes:used-in", {
          count: model.usedIn,
        })}{#if model.stop.view.kind === "frame"}
          · {t("galatsa.routes:frame-stop")}{/if}
      </p>
      <div class="row">
        <button type="button" onclick={act(() => goTo(chosen.entry, chosen.stop))}
          >{t("galatsa.routes:go-to-stop")}</button
        >
        <button
          type="button"
          onclick={act(() => run(ROUTES.updateStopView, { stop: chosen.stop }))}
          >{t("galatsa.routes:update-stop-view")}</button
        >
        {#if model.visits > 1}
          <button
            type="button"
            onclick={act(() =>
              run(ROUTES.copyStopForRoute, { route, entry: chosen.entry }),
            )}>{t("galatsa.routes:copy-stop-for-route")}</button
          >
        {/if}
      </div>

      <h4>{t("galatsa.routes:visibility")}</h4>
      <div class="row">
        <button
          type="button"
          disabled={selectionSize === 0}
          onclick={act(() =>
            run(ROUTES.setVisibility, { stop: chosen.stop, action: "show" }),
          )}>{t("galatsa.routes:show-here")}</button
        >
        <button
          type="button"
          disabled={selectionSize === 0}
          onclick={act(() =>
            run(ROUTES.setVisibility, { stop: chosen.stop, action: "hide" }),
          )}>{t("galatsa.routes:hide-here")}</button
        >
        <button
          type="button"
          disabled={selectionSize === 0}
          onclick={act(() =>
            run(ROUTES.setVisibility, { stop: chosen.stop, action: null }),
          )}>{t("galatsa.routes:clear-here")}</button
        >
      </div>
      {#if model.visibility.length === 0}
        <p class="hint">{t("galatsa.routes:visibility.none")}</p>
      {:else}
        <ul class="changes">
          {#each model.visibility as change (change.id)}
            <li>
              <span class="name">{change.label}</span>
              <span class="action"
                >{change.action === "show"
                  ? t("galatsa.routes:visibility.show")
                  : t("galatsa.routes:visibility.hide")}</span
              >
              <button
                type="button"
                class="icon"
                aria-label={t("galatsa.routes:visibility.remove")}
                title={t("galatsa.routes:visibility.remove")}
                onclick={act(() =>
                  run(ROUTES.setVisibility, {
                    stop: chosen.stop,
                    ids: [change.id],
                    action: null,
                  }),
                )}>×</button
              >
            </li>
          {/each}
        </ul>
      {/if}

      <div class="field">
        <label for="{uid}-notes">{t("galatsa.routes:notes")}</label>
        {#key chosen.stop}
          <DraftField
            id="{uid}-notes"
            target={chosen.stop}
            value={model.notes}
            multiline
            oncommit={(stop, text) => run(ROUTES.setStopNotes, { stop, text })}
          />
        {/key}
      </div>
      <div class="row">
        <button
          type="button"
          onclick={act(() => run(ROUTES.removeVisit, { route, entry: chosen.entry }))}
          >{t("galatsa.routes:remove-visit")}</button
        >
        <button type="button" class="danger" onclick={() => askDelete(chosen.stop)}
          >{t("galatsa.routes:delete-stop")}</button
        >
      </div>
    </section>
  {/if}
</div>

{#if deleting !== null}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onmousedown={keepFocus}>
    <div
      bind:this={dialog}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="{uid}-delete"
      aria-describedby="{uid}-delete-text"
      class="dialog"
      tabindex="-1"
    >
      <h2 id="{uid}-delete">{t("galatsa.routes:delete.title")}</h2>
      <p id="{uid}-delete-text">
        {t("galatsa.routes:delete.used", { count: deletingCount })}
      </p>
      <div class="row end">
        <button type="button" use:focusOnMount onclick={closeDialog}
          >{t("galatsa.routes:cancel")}</button
        >
        <button type="button" class="danger" onclick={confirmDelete}
          >{t("galatsa.routes:delete.confirm")}</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 16px;
  }
  h3,
  h4 {
    margin: 4px 0 0;
    font-size: 13px;
    color: #475569;
  }
  .hint {
    margin: 0;
    color: #64748b;
    font-size: 13px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 13px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  select {
    font: inherit;
    padding: 4px 6px;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: flex-end;
  }
  .end {
    justify-content: flex-end;
  }
  button {
    font: inherit;
    padding: 4px 8px;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    background: #f8fafc;
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button.icon {
    padding: 2px 6px;
    background: transparent;
  }
  button.danger {
    border-color: #fca5a5;
    color: #b91c1c;
  }
  .steps,
  .changes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .steps li,
  .changes li {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .steps li.chosen .step {
    border-color: #db2777;
    background: #fdf2f8;
  }
  .step {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 8px;
    text-align: left;
  }
  .number {
    color: #7c3aed;
    font-weight: 600;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .action {
    color: #475569;
    font-size: 12px;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(15, 23, 42, 0.25);
    z-index: 10;
  }
  .dialog {
    max-width: min(28rem, calc(100% - 32px));
    padding: 16px 20px;
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .dialog p {
    margin: 0;
  }
</style>
