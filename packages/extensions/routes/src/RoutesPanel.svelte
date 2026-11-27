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
  import type { ElementId, RouteEntryId, StopId } from "@galatsa/core";
  import { roots } from "@galatsa/core/ydoc";
  import { translator, type PanelProps } from "@galatsa/editor";
  import { untrack } from "svelte";
  import { ROUTES, ROUTES_PANEL, routesCommandEnabled } from "./commands.ts";
  import {
    firstPlaces,
    liveRoutes,
    liveStops,
    readRoutes,
    routeSteps,
    routesUsing,
    type StopsAndRoutes,
  } from "./model.ts";
  import { choose, currentChoice, watchChoice } from "./state.ts";

  let { context, i18n }: PanelProps = $props();

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

  /** An element's name as the user gave it, or "". */
  function elementName(id: ElementId): string {
    const record = roots(doc).elements.get(id);
    const name = record?.get("name");
    return typeof name === "string" ? name : "";
  }

  /** The stop's name, the name of its frame, or its place in a route. */
  function stopLabel(sr: StopsAndRoutes, stop: StopId, position: number): string {
    const record = sr.stops[stop];
    if (record === undefined) return "";
    if (record.name !== "") return record.name;
    if (record.view.kind === "frame") {
      const name = elementName(record.view.frame);
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
            label: elementName(id) || t("galatsa.routes:element.untitled"),
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

  function run(id: string, args?: unknown): void {
    try {
      context.run(id, args);
    } catch (error) {
      console.error(error);
    }
  }

  let existingStop = $state<string>("");
  let deleting = $state<{ stop: StopId; count: number } | null>(null);

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

  /** Deleting a stop that routes use asks first (the users' decision). */
  function askDelete(stop: StopId): void {
    const count = routesUsing(readRoutes(doc), stop).length;
    if (count === 0) run(ROUTES.deleteStop, { stop });
    else deleting = { stop, count };
  }

  function confirmDelete(): void {
    if (deleting === null) return;
    const stop = deleting.stop;
    deleting = null;
    run(ROUTES.deleteStop, { stop });
  }

  function dialogKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      deleting = null;
    }
  }

  /**
   * A press on a button keeps the keyboard focus where it is (the canvas), so
   * Ctrl+Z still undoes what the button did; a text field being edited keeps
   * it too, so its change is not cut short.
   */
  function keepFocus(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element) || target.closest("button") === null) return;
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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="panel" onmousedown={keepFocus}>
  <header>
    <h2 id="{uid}-title">{t("galatsa.routes:panel")}</h2>
    <button
      type="button"
      class="icon"
      aria-label={t("galatsa.routes:close")}
      title={t("galatsa.routes:close")}
      onclick={() => context.services.panels.close(ROUTES_PANEL)}>×</button
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
        onchange={(e) => chooseRoute(e.currentTarget.value)}
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
        <input
          id="{uid}-route-name"
          type="text"
          value={model.routeName}
          onchange={(e) =>
            run(ROUTES.renameRoute, { route, name: e.currentTarget.value })}
        />
      </div>
    {/if}
  {/if}
  <div class="row">
    <button type="button" onclick={() => run(ROUTES.addRoute)}
      >{t("galatsa.routes:add-route")}</button
    >
    {#if model.route !== null}
      {@const route = model.route}
      <button type="button" onclick={() => run(ROUTES.deleteRoute, { route })}
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
            onclick={() => goTo(s.entry, s.stop)}
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
            onclick={() => move(s.entry, i - 1)}>↑</button
          >
          <button
            type="button"
            class="icon"
            aria-label={t("galatsa.routes:move-down")}
            title={t("galatsa.routes:move-down")}
            disabled={i === model.steps.length - 1}
            onclick={() => move(s.entry, i + 1)}>↓</button
          >
        </li>
      {/each}
    </ol>
  {/if}
  <div class="row">
    <button type="button" onclick={() => run(ROUTES.addStopFromView)}
      >{t("galatsa.routes:add-stop-from-view")}</button
    >
    <button
      type="button"
      disabled={selectionSize === 0 || !can(ROUTES.addStopsFromFrames)}
      onclick={() => run(ROUTES.addStopsFromFrames)}
      >{t("galatsa.routes:add-stops-from-frames")}</button
    >
  </div>
  {#if model.existing.length > 0}
    <div class="row">
      <div class="field grow">
        <label for="{uid}-existing">{t("galatsa.routes:existing")}</label>
        <select id="{uid}-existing" bind:value={existingStop}>
          <option value=""></option>
          {#each model.existing as stop (stop.id)}
            <option value={stop.id}>{stop.label}</option>
          {/each}
        </select>
      </div>
      <button type="button" disabled={existingStop === ""} onclick={addExisting}
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
        <input
          id="{uid}-stop-name"
          type="text"
          value={model.stop.name}
          onchange={(e) =>
            run(ROUTES.renameStop, { stop: chosen.stop, name: e.currentTarget.value })}
        />
      </div>
      <p class="hint">
        {t("galatsa.routes:used-in", {
          count: model.usedIn,
        })}{#if model.stop.view.kind === "frame"}
          · {t("galatsa.routes:frame-stop")}{/if}
      </p>
      <div class="row">
        <button type="button" onclick={() => goTo(chosen.entry, chosen.stop)}
          >{t("galatsa.routes:go-to-stop")}</button
        >
        <button
          type="button"
          onclick={() => run(ROUTES.updateStopView, { stop: chosen.stop })}
          >{t("galatsa.routes:update-stop-view")}</button
        >
        {#if model.visits > 1}
          <button
            type="button"
            onclick={() => run(ROUTES.copyStopForRoute, { route, entry: chosen.entry })}
            >{t("galatsa.routes:copy-stop-for-route")}</button
          >
        {/if}
      </div>

      <h4>{t("galatsa.routes:visibility")}</h4>
      <div class="row">
        <button
          type="button"
          disabled={selectionSize === 0}
          onclick={() => run(ROUTES.setVisibility, { stop: chosen.stop, action: "show" })}
          >{t("galatsa.routes:show-here")}</button
        >
        <button
          type="button"
          disabled={selectionSize === 0}
          onclick={() => run(ROUTES.setVisibility, { stop: chosen.stop, action: "hide" })}
          >{t("galatsa.routes:hide-here")}</button
        >
        <button
          type="button"
          disabled={selectionSize === 0}
          onclick={() => run(ROUTES.setVisibility, { stop: chosen.stop, action: null })}
          >{t("galatsa.routes:clear-here")}</button
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
                onclick={() =>
                  run(ROUTES.setVisibility, {
                    stop: chosen.stop,
                    ids: [change.id],
                    action: null,
                  })}>×</button
              >
            </li>
          {/each}
        </ul>
      {/if}

      <div class="field">
        <label for="{uid}-notes">{t("galatsa.routes:notes")}</label>
        <textarea
          id="{uid}-notes"
          rows="4"
          value={model.notes}
          onchange={(e) =>
            run(ROUTES.setStopNotes, { stop: chosen.stop, text: e.currentTarget.value })}
        ></textarea>
      </div>
      <div class="row">
        <button
          type="button"
          onclick={() => run(ROUTES.removeVisit, { route, entry: chosen.entry })}
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
  <div class="backdrop">
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="{uid}-delete"
      aria-describedby="{uid}-delete-text"
      class="dialog"
      tabindex="-1"
      onkeydown={dialogKey}
    >
      <h2 id="{uid}-delete">{t("galatsa.routes:delete.title")}</h2>
      <p id="{uid}-delete-text">
        {t("galatsa.routes:delete.used", { count: deleting.count })}
      </p>
      <div class="row end">
        <button type="button" use:focusOnMount onclick={() => (deleting = null)}
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
  input,
  select,
  textarea {
    font: inherit;
    padding: 4px 6px;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
  }
  textarea {
    resize: vertical;
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
