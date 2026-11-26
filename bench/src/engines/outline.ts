// SPDX-License-Identifier: GPL-3.0-or-later

// A reference engine that draws only the outline of each visible element on a 2D
// canvas: shapes in their colour, text boxes in grey with a line per text line,
// images as a crossed box. Not a candidate engine; it shows the coordinate
// convention of CameraPose and lets people see what the camera run looks at.

import type { CameraPose } from "../camera.ts";
import type { BenchEngine, BenchViewport } from "../engine.ts";
import type { SceneElement } from "../scene.ts";

export function createOutlineEngine(): BenchEngine {
  let canvas: HTMLCanvasElement | undefined;
  let context: CanvasRenderingContext2D | undefined;
  let viewport: BenchViewport = { width: 0, height: 0, devicePixelRatio: 1 };
  let elements: readonly SceneElement[] = [];
  let reportTextSharp = (): void => {};

  return {
    name: "outline",
    load(setup) {
      viewport = setup.viewport;
      elements = setup.scene.elements;
      reportTextSharp = setup.reportTextSharp;
      canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width * viewport.devicePixelRatio);
      canvas.height = Math.round(viewport.height * viewport.devicePixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setup.container.append(canvas);
      context = canvas.getContext("2d") ?? undefined;
      if (context === undefined) return Promise.reject(new Error("No 2D canvas context"));
      return Promise.resolve();
    },
    render(camera: CameraPose) {
      if (context === undefined) return;
      const ctx = context;
      const dpr = viewport.devicePixelRatio;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      // World to device pixels: (w - camera) * zoom + viewport / 2, times dpr.
      const scale = camera.zoom * dpr;
      const offsetX = (viewport.width / 2) * dpr - camera.x * scale;
      const offsetY = (viewport.height / 2) * dpr - camera.y * scale;
      // Visible world rectangle, for culling (ignores rotation, so it keeps a margin).
      const halfW = viewport.width / 2 / camera.zoom;
      const halfH = viewport.height / 2 / camera.zoom;
      const left = camera.x - halfW;
      const right = camera.x + halfW;
      const top = camera.y - halfH;
      const bottom = camera.y + halfH;
      ctx.lineWidth = 1;
      for (const e of elements) {
        const margin = Math.max(e.width, e.height) / 2;
        if (
          e.x + e.width + margin < left ||
          e.x - margin > right ||
          e.y + e.height + margin < top ||
          e.y - margin > bottom
        ) {
          continue;
        }
        const cx = e.x + e.width / 2;
        const cy = e.y + e.height / 2;
        const angle = (e.rotation * Math.PI) / 180;
        const cos = Math.cos(angle) * scale;
        const sin = Math.sin(angle) * scale;
        ctx.setTransform(cos, sin, -sin, cos, cx * scale + offsetX, cy * scale + offsetY);
        const x = -e.width / 2;
        const y = -e.height / 2;
        ctx.lineWidth = 1 / scale;
        if (e.kind === "shape") {
          ctx.strokeStyle = e.stroke ?? e.fill ?? "#000";
          ctx.strokeRect(x, y, e.width, e.height);
        } else if (e.kind === "text") {
          ctx.strokeStyle = "#888";
          ctx.strokeRect(x, y, e.width, e.height);
          ctx.beginPath();
          const step = e.fontSize * e.lineHeight;
          for (let ly = y + step; ly < y + e.height && step * scale > 2; ly += step) {
            ctx.moveTo(x, ly);
            ctx.lineTo(x + e.width, ly);
          }
          ctx.stroke();
        } else {
          ctx.strokeStyle = "#06c";
          ctx.strokeRect(x, y, e.width, e.height);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + e.width, y + e.height);
          ctx.moveTo(x + e.width, y);
          ctx.lineTo(x, y + e.height);
          ctx.stroke();
        }
      }
      // Lines are always drawn at device resolution, so "text" is always sharp.
      reportTextSharp();
    },
    snapshot() {
      const source = canvas;
      if (source === undefined) return Promise.reject(new Error("Not loaded"));
      return new Promise<Blob>((resolve, reject) =>
        source.toBlob((blob) =>
          blob !== null ? resolve(blob) : reject(new Error("Snapshot failed")),
        ),
      );
    },
    dispose() {
      canvas?.remove();
      canvas = undefined;
      context = undefined;
      elements = [];
      reportTextSharp = () => {};
    },
  };
}
