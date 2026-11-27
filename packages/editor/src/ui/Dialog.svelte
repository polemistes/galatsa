<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- A modal dialog over the canvas, with a heading. -->
<script lang="ts">
  import type { Snippet } from "svelte";

  let { heading, children }: { heading: string; children: Snippet } = $props();
</script>

<div class="backdrop">
  <div role="dialog" aria-modal="true" aria-label={heading} class="dialog">
    <h2>{heading}</h2>
    {@render children()}
  </div>
</div>

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(15, 23, 42, 0.25);
    pointer-events: auto;
  }
  .dialog {
    max-width: min(32rem, calc(100% - 32px));
    padding: 16px 20px;
    background: #fff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  .dialog :global(.buttons) {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
</style>
