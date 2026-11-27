// SPDX-License-Identifier: GPL-3.0-or-later

// Screenshot test of in-place editing (docs/adr/0011-text.md): a text box with
// bold, italic, coloured text, a bulleted list, ligatures and Norwegian
// letters is shown at zoom 0.1, 1, 8 and 40, first as the canvas draws it and
// then with editing started, when the browser's editing element shows it
// instead. The two pictures must be the same: the same pixels, a pixel of
// difference allowed for rasterising, and no shift of the text as a whole.
// The pictures are compared with each other in the same run, so they need no
// stored copies and do not depend on how the platform rasterises the fonts;
// both are attached to the test's results.
//
// The caret is hidden and the overlay (selection and editing outlines) is
// turned off, so that only the text is compared.

import { expect, test, type Page } from "@playwright/test";
import { frames, openEmpty, type Dev, type DevEditor } from "./text-support.ts";

const TEXT =
  "Bold and italic words with Galatsa, wrapping nicely along.\n" +
  "A list item that is long enough to wrap onto two lines\n" +
  "Another item\n" +
  "The end. Æøå ÆØÅ fi ffl";

/** How two screenshots differ, compared in the page. */
interface Difference {
  /** Pixels darker than mid-grey in the first picture (the text). */
  readonly ink: number;
  /** Pixels that differ by more than a quarter of the range from every pixel around them in the other. */
  readonly differing: number;
  /** How far the text's centre of mass moved, in pixels. */
  readonly shift: readonly [number, number];
}

async function difference(page: Page, a: Buffer, b: Buffer): Promise<Difference> {
  return page.evaluate(
    async ([first, second]) => {
      const load = async (base64: string): Promise<ImageData> => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      };
      const A = await load(first!);
      const B = await load(second!);
      const light = (d: ImageData, x: number, y: number): number => {
        const i = (y * d.width + x) * 4;
        return (d.data[i]! + d.data[i + 1]! + d.data[i + 2]!) / 3;
      };
      let ink = 0;
      let differing = 0;
      const mass = [0, 0, 0, 0, 0, 0];
      for (let y = 0; y < A.height; y++)
        for (let x = 0; x < A.width; x++) {
          const a = light(A, x, y);
          const b = light(B, x, y);
          if (a < 160) {
            ink++;
            mass[0]! += x;
            mass[1]! += y;
            mass[2]!++;
          }
          if (b < 160) {
            mass[3]! += x;
            mass[4]! += y;
            mass[5]!++;
          }
          let nearest = 255;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= B.width || ny >= B.height) continue;
              nearest = Math.min(nearest, Math.abs(a - light(B, nx, ny)));
            }
          if (nearest > 64) differing++;
        }
      return {
        ink,
        differing,
        shift: [
          mass[3]! / Math.max(1, mass[5]!) - mass[0]! / Math.max(1, mass[2]!),
          mass[4]! / Math.max(1, mass[5]!) - mass[1]! / Math.max(1, mass[2]!),
        ] as const,
      };
    },
    [a.toString("base64"), b.toString("base64")] as const,
  );
}

test("text looks the same while it is edited, at zoom 0.1, 1, 8 and 40", async ({
  page,
}, info) => {
  const errors = await openEmpty(page);
  await page.addStyleTag({
    content: ".galatsa-text-edit { caret-color: transparent !important; }",
  });
  const surface = page.locator(".galatsa-canvas");
  const box = (await surface.boundingBox())!;
  const id = await page.evaluate((text) => {
    const editor = (window as unknown as Dev).galatsaDev.editor() as DevEditor;
    const outcome = editor.run("galatsa.text/insert", {
      x: 0,
      y: 0,
      w: 1200,
      fontSize: 60,
      text,
    });
    const elementId = outcome.value as string;
    const shared = editor.doc.getMap("elements").get(elementId).get("data").get("text");
    editor.doc.transact(() => {
      shared.format(0, 4, { bold: true });
      shared.format(9, 6, { italic: true });
      shared.format(16, 5, { bold: true, italic: true, color: "#b91c1c" });
      const s = shared.toString();
      const first = s.indexOf("\n");
      const second = s.indexOf("\n", first + 1);
      const third = s.indexOf("\n", second + 1);
      shared.format(second, 1, { list: "bullet" });
      shared.format(third, 1, { list: "bullet" });
      // A tab written by another program (typing and pasting make spaces
      // of tabs): both show it as a space.
      (shared as unknown as { insert(at: number, text: string): void }).insert(
        s.length - 1,
        "\tTab",
      );
    }, "galatsa:local");
    editor.services.selection.set([]);
    editor.renderer.setOverlay(null);
    return elementId;
  }, TEXT);

  const clip = {
    x: box.x + 10,
    y: box.y + 10,
    width: box.width - 20,
    height: box.height - 80,
  };
  for (const [zoom, cx, cy] of [
    [0.1, 600, 150],
    [1, 600, 150],
    [8, 200, 60],
    [40, 60, 40],
  ] as const) {
    await page.evaluate(
      ([z, x, y]) =>
        ((window as unknown as Dev).galatsaDev.editor() as DevEditor).services.camera.set(
          {
            space: null,
            cx: x,
            cy: y,
            zoom: z,
          },
        ),
      [zoom, cx, cy] as const,
    );
    await frames(page);
    const drawn = await page.screenshot({ clip });
    await page.evaluate(
      (elementId) =>
        ((window as unknown as Dev).galatsaDev.editor() as DevEditor).editText(elementId),
      id,
    );
    await expect(page.locator(".galatsa-text-edit")).toBeFocused();
    await frames(page);
    const edited = await page.screenshot({ clip });
    await info.attach(`zoom ${zoom}, drawn`, { body: drawn, contentType: "image/png" });
    await info.attach(`zoom ${zoom}, edited`, { body: edited, contentType: "image/png" });
    const d = await difference(page, drawn, edited);
    // The text is there (zoom 0.1 shows it 6 pixels high), the pictures
    // agree but for a few pixels of rasterising, and the text did not move.
    expect(d.ink, `zoom ${zoom}`).toBeGreaterThan(300);
    expect(d.differing / d.ink, `zoom ${zoom}: ${JSON.stringify(d)}`).toBeLessThan(0.05);
    expect(Math.abs(d.shift[0]), `zoom ${zoom}: ${JSON.stringify(d)}`).toBeLessThan(1.5);
    expect(Math.abs(d.shift[1]), `zoom ${zoom}: ${JSON.stringify(d)}`).toBeLessThan(1.5);
    await page.keyboard.press("Escape");
    await expect(page.locator(".galatsa-text-edit")).toHaveCount(0);
    await page.evaluate(() =>
      (
        (window as unknown as Dev).galatsaDev.editor() as DevEditor
      ).services.selection.set([]),
    );
  }
  expect(errors).toEqual([]);
});
