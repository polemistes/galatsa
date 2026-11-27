<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  The properties panel (docs/adr/0005, section 3.9; docs/adr/0016): the
  fields of the selected elements' types that apply to all of them, with a
  mixed state where their values differ. Every change runs the field's
  command, so it is one undo step; a colour being dragged is previewed and
  committed once.
-->
<script lang="ts">
  import type { Json } from "@galatsa/core";
  import type { Editor } from "../editor.ts";
  import {
    changeField,
    FieldGesture,
    propertiesModel,
    type PropertyField,
  } from "./properties.ts";
  import { editorChanges, translator, Watched } from "./reactive.ts";

  let { editor }: { editor: Editor } = $props();

  const t = $derived(translator(editor.i18n));
  const model = $derived(new Watched(editorChanges(editor), () => propertiesModel(editor)));
  const sections = $derived(model.current);

  /** The colour being dragged, per field. */
  const gestures = new Map<string, FieldGesture>();

  function fieldId(type: string, field: PropertyField): string {
    return `galatsa-field-${type}-${field.key}`.replace(/[^A-Za-z0-9_-]/g, "-");
  }

  /** A colour as a colour input takes it (#rrggbb). */
  function hex(value: Json): string {
    if (typeof value !== "string") return "#000000";
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
    if (short !== null) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
    return "#000000";
  }

  function setNumber(field: PropertyField, event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    if (input.value.trim() === "") return;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    const control = field.control;
    if (control.kind !== "number") return;
    const clamped = Math.min(control.max ?? Infinity, Math.max(control.min ?? -Infinity, value));
    changeField(editor, field, clamped);
  }

  function previewColor(id: string, field: PropertyField, event: Event): void {
    const value = (event.currentTarget as HTMLInputElement).value;
    let gesture = gestures.get(id);
    if (gesture === undefined) {
      gesture = new FieldGesture(editor, field);
      gestures.set(id, gesture);
    }
    gesture.preview(value);
  }

  function commitColor(id: string, field: PropertyField, event: Event): void {
    const value = (event.currentTarget as HTMLInputElement).value;
    const gesture = gestures.get(id);
    gestures.delete(id);
    if (gesture !== undefined) gesture.commit(value);
    else changeField(editor, field, value);
  }

  function setNone(field: PropertyField, event: Event): void {
    const none = (event.currentTarget as HTMLInputElement).checked;
    changeField(editor, field, none ? null : hex(field.value ?? "#000000"));
  }

  function setChoice(field: PropertyField, event: Event): void {
    if (field.control.kind !== "select") return;
    const index = Number((event.currentTarget as HTMLSelectElement).value);
    const option = field.control.options[index];
    if (option !== undefined) changeField(editor, field, option.value);
  }

  function chosenIndex(field: PropertyField): string {
    if (field.mixed || field.control.kind !== "select") return "";
    const value = JSON.stringify(field.value);
    const index = field.control.options.findIndex((o) => JSON.stringify(o.value) === value);
    return index < 0 ? "" : String(index);
  }

  function setToggle(field: PropertyField, event: Event): void {
    changeField(editor, field, (event.currentTarget as HTMLInputElement).checked);
  }

  function setText(field: PropertyField, event: Event): void {
    changeField(editor, field, (event.currentTarget as HTMLInputElement).value);
  }
</script>

{#if sections.length > 0}
  <aside class="galatsa-properties" aria-label={t("editor:properties.label")}>
    {#each sections as section (section.type)}
      <section>
        <h2>
          {t(section.label)}
          {#if section.ids.length > 1}
            <span class="count">{t("editor:properties.count", { count: section.ids.length })}</span>
          {/if}
        </h2>
        {#each section.fields as field (field.key)}
          {@const id = fieldId(section.type, field)}
          {@const control = field.control}
          <div class="field" data-key={field.key}>
            <label for={id}>{t(field.label)}</label>
            <div class="control">
              {#if control.kind === "number"}
                <input
                  {id}
                  type="number"
                  min={control.min}
                  max={control.max}
                  step={control.step ?? "any"}
                  value={field.mixed || typeof field.value !== "number" ? "" : field.value}
                  placeholder={field.mixed ? t("editor:properties.mixed") : ""}
                  onchange={(event) => setNumber(field, event)}
                />
                {#if control.unit !== undefined}
                  <span class="unit">{t(control.unit)}</span>
                {/if}
              {:else if control.kind === "color"}
                <input
                  {id}
                  type="color"
                  value={hex(field.value)}
                  disabled={field.value === null && !field.mixed}
                  oninput={(event) => previewColor(id, field, event)}
                  onchange={(event) => commitColor(id, field, event)}
                />
                {#if control.allowNone}
                  <label class="none">
                    <input
                      type="checkbox"
                      checked={field.value === null && !field.mixed}
                      onchange={(event) => setNone(field, event)}
                    />
                    {t("editor:properties.none")}
                  </label>
                {/if}
                {#if field.mixed}
                  <span class="mixed">{t("editor:properties.mixed")}</span>
                {/if}
              {:else if control.kind === "select"}
                <select {id} value={chosenIndex(field)} onchange={(event) => setChoice(field, event)}>
                  {#if chosenIndex(field) === ""}
                    <option value="" disabled>{t("editor:properties.mixed")}</option>
                  {/if}
                  {#each control.options as option, index (index)}
                    <option value={String(index)}>{t(option.label)}</option>
                  {/each}
                </select>
              {:else if control.kind === "toggle"}
                <input
                  {id}
                  type="checkbox"
                  checked={field.value === true && !field.mixed}
                  indeterminate={field.mixed}
                  onchange={(event) => setToggle(field, event)}
                />
              {:else if control.multiline}
                <textarea
                  {id}
                  value={field.mixed || typeof field.value !== "string" ? "" : field.value}
                  placeholder={field.mixed ? t("editor:properties.mixed") : ""}
                  onchange={(event) => setText(field, event)}
                ></textarea>
              {:else}
                <input
                  {id}
                  type="text"
                  value={field.mixed || typeof field.value !== "string" ? "" : field.value}
                  placeholder={field.mixed ? t("editor:properties.mixed") : ""}
                  onchange={(event) => setText(field, event)}
                />
              {/if}
            </div>
          </div>
        {/each}
      </section>
    {/each}
  </aside>
{/if}

<style>
  aside {
    width: min(16rem, calc(100vw - 32px));
    min-height: 0;
    overflow: auto;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.96);
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
    pointer-events: auto;
    box-sizing: border-box;
  }
  section + section {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #e2e8f0;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 14px;
    font-weight: 600;
  }
  .count {
    font-weight: 400;
    color: #64748b;
    margin-inline-start: 4px;
  }
  .field {
    display: grid;
    grid-template-columns: 6.5rem 1fr;
    align-items: center;
    gap: 6px;
    margin: 4px 0;
  }
  .control {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }
  input[type="number"],
  input[type="text"],
  select,
  textarea {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    font: inherit;
    padding: 3px 6px;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    background: #fff;
    color: inherit;
  }
  input[type="number"] {
    width: 5.5rem;
  }
  input[type="color"] {
    width: 40px;
    height: 28px;
    padding: 1px 2px;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    background: #fff;
  }
  .none {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .mixed,
  .unit {
    color: #64748b;
  }
</style>
