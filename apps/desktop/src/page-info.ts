// SPDX-License-Identifier: GPL-3.0-or-later

// What the page knows about its own surroundings, saved with every result.

export interface PageInfo {
  readonly userAgent: string;
  readonly devicePixelRatio: number;
  /** The window's content size in CSS pixels. */
  readonly window: { readonly width: number; readonly height: number };
  readonly screen: {
    readonly width: number;
    readonly height: number;
    readonly availWidth: number;
    readonly availHeight: number;
    readonly colorDepth: number;
  };
  /**
   * The graphics adapter as WebGL reports it, if it does. WebKitGTK reports a
   * fixed "Apple GPU" on Linux, so the host's list of adapters is the better source.
   */
  readonly webgl: { readonly vendor: string | null; readonly renderer: string | null };
  readonly crossOriginIsolated: boolean;
}

function webglInfo(): PageInfo["webgl"] {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (gl === null) return { vendor: null, renderer: null };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = ext !== null ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null;
    const renderer = ext !== null ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return {
      vendor: typeof vendor === "string" ? vendor : null,
      renderer: typeof renderer === "string" ? renderer : null,
    };
  } catch {
    return { vendor: null, renderer: null };
  }
}

export function pageInfo(): PageInfo {
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    window: {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    },
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
    },
    webgl: webglInfo(),
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  };
}
