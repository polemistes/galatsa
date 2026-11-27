<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!--
  A text field whose text is saved when the user leaves it, or presses Enter
  in a one-line field. While the user has changed it and not saved, a new
  value from the document (another user's edit) does not overwrite what they
  typed; and what they typed is saved if the field goes away first (the stop
  was deleted, or another one chosen). `target` names what the text belongs to
  and is fixed for the field's life: key the field by it. See
  docs/adr/0013-routes-and-stops.md.
-->
<script lang="ts">
  import { onDestroy, untrack } from "svelte";

  let {
    id,
    target,
    value,
    multiline = false,
    oncommit,
  }: {
    id: string;
    target: string;
    value: string;
    multiline?: boolean;
    oncommit: (target: string, text: string) => void;
  } = $props();

  // Fixed when the field is made: the field is keyed by its target.
  const owner = untrack(() => target);
  const save = untrack(() => oncommit);

  let draft = $state(untrack(() => value));
  let saved = untrack(() => value);
  /** The user typed since the last save. */
  let dirty = false;

  $effect.pre(() => {
    const next = value;
    saved = next;
    if (!dirty) draft = next;
  });

  function input(event: Event): void {
    draft = (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
    dirty = true;
  }

  function commit(): void {
    if (!dirty) return;
    dirty = false;
    if (draft !== saved) save(owner, draft);
  }

  onDestroy(commit);
</script>

{#if multiline}
  <textarea {id} rows="4" value={draft} oninput={input} onchange={commit}></textarea>
{:else}
  <input {id} type="text" value={draft} oninput={input} onchange={commit} />
{/if}

<style>
  input,
  textarea {
    font: inherit;
    padding: 4px 6px;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
  }
  textarea {
    resize: vertical;
  }
</style>
