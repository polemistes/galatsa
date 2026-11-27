<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- An icon of the program's icon set (icons.ts), drawn in the text colour. -->
<script lang="ts">
  let { path }: { path: string } = $props();
</script>

<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
  <path d={path} />
</svg>

<style>
  svg {
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
