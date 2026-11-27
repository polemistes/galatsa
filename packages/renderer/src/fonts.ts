// SPDX-License-Identifier: GPL-3.0-or-later

// The fonts the program ships, and waiting for them before laying text out.
// Generic family names (what element types store) map to bundled families;
// the browser's own generic fonts are only the fallback, since they differ
// between browsers and systems (docs/adr/0004, "Bundled fonts"). The font
// files and their licences: docs/adr/0011-text.md. A page loads them with
// `import "@galatsa/renderer/fonts.css"`.

/** Generic family names and the CSS families they stand for. */
export type FontFamilies = Readonly<Record<string, string>>;

/** The bundled families, by generic name. */
export const BUNDLED_FAMILIES: FontFamilies = {
  sans: '"Noto Sans", sans-serif',
  "sans-serif": '"Noto Sans", sans-serif',
  serif: '"Noto Serif", serif',
  mono: '"Noto Sans Mono", monospace',
  monospace: '"Noto Sans Mono", monospace',
};

/** The CSS family for a generic name; an unknown name falls back to sans. */
export function cssFamily(families: FontFamilies, name: string): string {
  return families[name] ?? families["sans"] ?? "sans-serif";
}

/**
 * Says whether fonts are loaded, and loads them when they are not. Text laid
 * out before its fonts are there would break its lines with a fallback font,
 * so the renderer lays such text out provisionally, does not keep that
 * layout, and draws again when the fonts have come.
 */
export interface FontWaiter {
  /**
   * True if every font (a CSS font string) is ready for `text`. If not, starts
   * loading what is missing and calls the waiter's `loaded` callback when it
   * has come (or failed: then the fallback is all there is).
   */
  ready(fonts: readonly string[], text: string): boolean;
}

/** Fonts are always ready (no document fonts: tests, workers). */
export const NO_WAIT: FontWaiter = { ready: () => true };

interface FontSet {
  check(font: string, text?: string): boolean;
  load(font: string, text?: string): Promise<unknown>;
}

/**
 * A waiter over a document's font set (`document.fonts`). `loaded` is called
 * once per batch of loads that settled.
 */
export function documentFontWaiter(fonts: FontSet, loaded: () => void): FontWaiter {
  const pending = new Set<string>();
  const failed = new Set<string>();
  return {
    ready(list, text) {
      let ready = true;
      for (const font of list) {
        const key = `${font}|${text}`;
        if (failed.has(key)) continue;
        let ok: boolean;
        try {
          ok = fonts.check(font, text);
        } catch {
          ok = true;
        }
        if (ok) continue;
        ready = false;
        if (pending.has(key)) continue;
        pending.add(key);
        fonts.load(font, text).then(
          () => {
            pending.delete(key);
            // A font that loaded nothing for this text (no face covers it)
            // would never pass check(); the fallback is final then.
            try {
              if (!fonts.check(font, text)) failed.add(key);
            } catch {
              failed.add(key);
            }
            loaded();
          },
          () => {
            pending.delete(key);
            failed.add(key);
            loaded();
          },
        );
      }
      return ready;
    },
  };
}

/** The bundled faces, as CSS font strings at a size, for loading ahead. */
export function bundledFaces(families: FontFamilies = BUNDLED_FAMILIES): string[] {
  const out: string[] = [];
  for (const name of ["sans", "serif", "mono"]) {
    const family = families[name];
    if (family === undefined) continue;
    for (const prefix of ["400 ", "700 ", "italic 400 ", "italic 700 "])
      out.push(`${prefix}16px ${family}`);
  }
  return out;
}
