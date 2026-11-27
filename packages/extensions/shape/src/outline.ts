// SPDX-License-Identifier: GPL-3.0-or-later

// Helpers for kinds that draw their outline: polygons with rounded corners.

import type { Path } from "@galatsa/extension-api";

/** A point of an outline, in the element's box. */
export interface OutlinePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Adds a closed polygon through `points`, with every corner rounded to
 * `radius` (0 for sharp corners). A corner's rounding is made smaller where
 * the edges beside it are too short for it, so neighbouring roundings never
 * overlap; a corner with no angle (three points in a line) stays as it is.
 * Clockwise or not, the outline is the same.
 */
export function polygon(
  path: Path,
  points: readonly OutlinePoint[],
  radius: number,
): void {
  const n = points.length;
  if (n === 0) return;
  if (!(radius > 0) || n < 3) {
    path.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < n; i += 1) path.lineTo(points[i]!.x, points[i]!.y);
    path.closePath();
    return;
  }
  for (let i = 0; i < n; i += 1) {
    const p = points[i]!;
    const a = points[(i + n - 1) % n]!;
    const b = points[(i + 1) % n]!;
    const la = Math.hypot(a.x - p.x, a.y - p.y);
    const lb = Math.hypot(b.x - p.x, b.y - p.y);
    const corner = (x: number, y: number): void =>
      i === 0 ? path.moveTo(x, y) : path.lineTo(x, y);
    if (la === 0 || lb === 0) {
      corner(p.x, p.y);
      continue;
    }
    const ux = (a.x - p.x) / la;
    const uy = (a.y - p.y) / la;
    const vx = (b.x - p.x) / lb;
    const vy = (b.y - p.y) / lb;
    const angle = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
    const half = Math.tan(angle / 2);
    if (!(half > 1e-12) || angle > Math.PI - 1e-9) {
      corner(p.x, p.y);
      continue;
    }
    // Distance from the corner to where the rounding meets each edge.
    const d = Math.min(radius / half, la / 2, lb / 2);
    const r = d * half;
    const bx = ux + vx;
    const by = uy + vy;
    const bl = Math.hypot(bx, by);
    const centre = r / Math.sin(angle / 2);
    const cx = p.x + (bx / bl) * centre;
    const cy = p.y + (by / bl) * centre;
    const a0 = Math.atan2(p.y + uy * d - cy, p.x + ux * d - cx);
    const a1 = Math.atan2(p.y + vy * d - cy, p.x + vx * d - cx);
    let delta = a1 - a0;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta <= -Math.PI) delta += 2 * Math.PI;
    corner(p.x + ux * d, p.y + uy * d);
    path.arc(cx, cy, r, a0, a1, delta < 0);
  }
  path.closePath();
}
