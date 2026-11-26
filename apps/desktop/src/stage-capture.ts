// SPDX-License-Identifier: GPL-3.0-or-later

// Images for capture runs. None of the engine prototypes implements snapshot(),
// and the web views offer the page no screenshot, so the app composes the image
// from the canvases inside the stage, at their positions on screen. That works for
// the canvas engines (Konva and the custom canvas engine). The DOM engine draws
// with elements, which a page cannot read back, so its capture runs have no images.

import type { HostCapture } from "@galatsa/bench/harness";

export const captureStageCanvases: HostCapture = async (rect) => {
  const stage = document.querySelector(".stage");
  const canvases = stage === null ? [] : [...stage.querySelectorAll("canvas")];
  const visible = canvases.filter((c) => {
    const style = getComputedStyle(c);
    return style.display !== "none" && style.visibility !== "hidden" && c.width > 0;
  });
  if (visible.length === 0) return null;
  const dpr = window.devicePixelRatio;
  const out = document.createElement("canvas");
  out.width = Math.round(rect.width * dpr);
  out.height = Math.round(rect.height * dpr);
  const ctx = out.getContext("2d");
  if (ctx === null) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  for (const canvas of visible) {
    const r = canvas.getBoundingClientRect();
    const opacity = Number(getComputedStyle(canvas).opacity);
    ctx.globalAlpha = Number.isFinite(opacity) ? opacity : 1;
    ctx.drawImage(
      canvas,
      (r.left - rect.x) * dpr,
      (r.top - rect.y) * dpr,
      r.width * dpr,
      r.height * dpr,
    );
  }
  return out.toDataURL("image/png");
};
