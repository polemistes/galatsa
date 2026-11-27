# 0012 Images and the asset store

- Status: proposed
- Date: 2026-11-27
- Code: `packages/extensions/image` (`@galatsa/extension-image`, and `@galatsa/extension-image/view` for the viewing part); `packages/format/src/previews.ts`; `packages/storage/src/previews.ts`; `packages/renderer/src/previews.ts` and the SVG and statistics parts of `packages/renderer/src/images.ts`; `packages/editor/src/import.ts`, `assets.ts`, `images.ts` and the file parts of `dom.ts`, `clipboard.ts`, `context-menu.ts` and `editor.ts`; `ImportContext.view` in `packages/extension-api`; `tests/e2e/images.spec.ts`

## Context

Galatsa needs images: import of PNG, JPEG, WebP and SVG files by dropping them on the canvas, pasting them and picking them, cropping, and an asset store in which each file is kept once, recognised by its content ([0001](0001-document-model-and-file-format.md) section 8). Reduced versions of each image are made when it is added, so that the renderer never decodes an original it does not need ([0004](0004-rendering-engine.md), "Image levels of detail"): decoding all originals at load was what made the canvas prototype climb to 6 GB and stall in WebKitGTK.

Two earlier decisions pulled in different directions. 0001 section 8.2 said that derived versions (downscaled images, posters) are a cache and never part of the document. 0004 said they are stored with the document, so that loading never decodes originals. And the users asked that shared files not be needlessly large (requirement R10).

## Decision

| Topic                     | Decision                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where reduced versions go | In the file, beside the assets, as entries of their own (`previews/<asset id>/<w>x<h>.<ext>`); not in the Y.Doc, not in `document.json`. A cache: a reader may ignore them, and they can always be made again.                                   |
| Sharing (R10)             | An export for sharing carries only the smallest version of each image (long side 256), about 1 to 2 % of the full set. The receiving program makes the others when an image is first drawn.                                                      |
| File format version       | Stays 1, with `minReaderVersion` 1. The new entries are an additive change of the kind 0001 section 9.1 provides for; no migration.                                                                                                              |
| Sizes                     | Long sides 256, 512, 1024 … up to 4096, each at most two thirds of the original's long side. None for images up to 383 pixels.                                                                                                                   |
| Encoding                  | WebP at quality 0.85; where the browser cannot encode WebP (WebKit), JPEG for opaque images and PNG for images with transparency.                                                                                                                |
| When they are made        | When the image is added: by the host's asset store, before the import's command runs. Missing ones (older files, shared files, pastes from another document) in the background, one image at a time, when the renderer first asks for the image. |
| Element type              | `galatsa.image/image`, layout version 1: `asset`, `crop`, `opacity`, as in 0001's provisional table.                                                                                                                                             |
| Cropping                  | The crop is a rectangle in the image's pixels; the element's box follows it so the part still shown stays where it was on the canvas. A crop tool (key C) drags its edges; one command, one undo step.                                           |
| Import                    | Files that are dropped, pasted or picked go to the importers; all files of one import are pasted with one command (one undo step), centred where they were dropped or in the view.                                                               |
| SVG                       | Stored as it is, drawn through an image element (no scripts, nothing loaded from outside), as a vector original that is rasterised at the size on screen, up to 8192 pixels.                                                                     |

### Where the reduced versions are stored

Three places were possible.

- **In the document** (the Y.Doc and `document.json`). Every peer would sync megabytes of pixels that any program can make from the asset, `document.json` would grow by the same, and an edit to an image (a crop) would not change them anyway. Rejected, as 0001 section 3.4 pattern 5 already says: derived data is never stored in the document.
- **Only in the program's own cache**, made after a file is opened. Then opening a file decodes every original once, which is exactly what 0004 measured as the 6 GB peak and the stalls in WebKitGTK. Rejected.
- **In the file, beside the assets, outside the document.** Chosen. Opening reads the stored versions and decodes only the ones on screen; the document and its merge identity are untouched; and because they are a cache, a writer may leave them out where size matters more than the first opening.

This reconciles 0001 and 0004: the reduced versions are **stored with the document's file** (0004) and are **never part of the document** (0001): not in the Y.Doc, not in `document.json`, not synced, and a reader that drops them loses nothing that cannot be made again. 0001 sections 8.2 and 9.1 are updated to say so.

**R10 (avoid needlessly large shared files, a requirement of the users).** Measured in Chromium with two generated 4000 × 3000 JPEGs (quality 0.9): a detailed, noisy picture of 5.6 MB got versions of 20, 71, 183 and 692 kB (long sides 256 to 2048), 17 % of the original; a smooth picture of 250 kB got 6, 12, 23 and 49 kB, 36 % of a much smaller file. Real photographs were not measured; assuming they lie between these in detail, the full set costs something like a fifth of a photo. For the program's own working file that is worth it: it opens fast and never decodes originals. In an **export for sharing** the writer keeps only the smallest version of each image by default (`previewsKept: "smallest"`; "all" and "none" can be asked for): 20 kB for the detailed picture, 0.4 % of its size. That is enough to open and draw the whole document without decoding an original, since a document is first seen as a whole; the receiving program makes the larger versions in the background when an image is first drawn, one at a time, from the original it has anyway.

The users' requirement is about sharing, so the normal save keeps everything. Whether a "smallest file" option should also leave out the smallest versions is a question for the users when export settings are built.

### The format

```
previews/sha256-<hex>/<width>x<height>.<webp|png|jpg>   stored, never compressed
```

- One entry per version. The name gives the asset, the pixel size and the encoding, so a reader needs no index and no manifest field. Width and height are integers from 1 to 16384.
- A writer writes the versions of every asset whose bytes belong in the file (0001 section 8.3), external ones included (their versions still show something when the large file next to the presentation is missing). At most 8 per asset, one per pixel size, smallest first.
- Entries are stored, like assets: they are compressed already, and a reader keeps them as views of the file's bytes, at no extra memory (0001 section 9.7).
- They are not hashed or checked against the asset. A damaged entry is caught by the archive's checksum and left out; a version that does not decode is skipped by the renderer, which then draws the next one. A crafted file could carry versions that show another picture than the original at small sizes; whoever makes a file controls its originals too, so this gives nothing a file could not do anyway.
- If the file would not fit with them (4 GiB, 65,534 entries), the writer writes it without them and says so (`previews-not-written`); a cache never makes a file unwritable.

**Versions.** This is the additive change 0001 section 9.1 foresaw: "a new kind of entry can only hold something that may be lost when an older version saves the file (a cache, a second preview)". So:

- `formatVersion` and `minReaderVersion` stay 1, and no migration is registered. Raising `formatVersion` would tell a reader nothing, since the entries describe themselves; raising `minReaderVersion` would lock out every older program for the sake of a cache.
- A version-1 program from before this change opens such a file, skips the entries unread (tested with the old acceptance rule), and writes the file back without them. The next program to open it makes them again, from the originals, when each image is first drawn.
- A file from before this change has no versions and opens as before; its images get them the same way.
- `document.json` and `ydoc.bin` are not affected, so "save and open give the same document" holds unchanged (the property tests run as before, and a test compares the document read from files with and without versions).

**In the store** (0006): `doc/<slot>/p/<asset id>/<w>x<h>.<ext>`, beside `doc/<slot>/a/<asset id>`, written once each, removed with the slot. Opening a file stores its versions; saving a file and exporting a stored copy read them. A session keeps the versions it made or opened in memory too, so a save works when the store does not, and writes them to the store later if it could not take them then.

### Making them

`makeImagePreviews` (renderer) decodes the original once, at the size of the largest version where the browser can (WebCodecs `ImageDecoder` decodes JPEG at reduced size; otherwise `createImageBitmap` with a resize), then scales each smaller version from the next larger one with high-quality smoothing, and encodes them. The host's asset store (`sessionAssetStore`, editor) calls it in `put`, when an importer stores an image's bytes, unless the store has versions of that asset already: the same image imported ten times is stored once and its versions made once. Images larger on screen than the largest version are drawn from the original, which `ImageDecoder` can also decode at half, quarter … size (0004).

The editor's image source (`assetImages`) gives the renderer the stored versions and the original last. Only the list of versions is fetched when the renderer first asks for an image (a list of keys in the store); the bytes of a version are read when the renderer decodes it. So opening a document reads no original. An image without versions is drawn from its original (read then), and its versions are made in the background.

### SVG

SVG is kept as it is (the asset's bytes are its identity). The renderer draws it through an image element, which runs no scripts and loads nothing from outside, after setting the root element's `width` and `height` to the size wanted (and a `viewBox` from its own size if it has none), so the browser rasterises the vector picture at that size instead of scaling a small picture. Its original is a **scalable** level: besides halves, the renderer offers it at twice, four times … its natural size up to 8192 pixels, so an SVG stays sharp when zoomed in. Neither `ImageDecoder` nor a worker can decode SVG, so it is decoded on the main thread; its reduced versions are raster images like any other's. The natural size comes from `width` and `height` in absolute units, else the `viewBox`, else 300 × 150, as browsers draw an SVG without a size.

### The image extension

`galatsa.image` replaces the sketch `examples.image`. Its data:

| Key       | Value                                                                                                                                    | Default |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `asset`   | The asset id of the image file.                                                                                                          | none    |
| `crop`    | `{x, y, w, h}` in the pixels of the image at its natural size (the asset description's width and height), or `null` for the whole image. | `null`  |
| `opacity` | 0 to 1.                                                                                                                                  | `1`     |

Reading is lenient for growth (0005 section 3.2): an opacity out of range is drawn clamped without a report, a crop that reaches outside the image is kept and drawn clipped. The commands check what they write.

- **Import** reads the format and pixel size from the file's bytes without decoding it: PNG, JPEG (with the EXIF orientation, which swaps width and height for photos taken on their side), lossy, lossless and extended WebP, SVG. The bytes decide; the media type the platform reports and the name are used only when the bytes do not. A new image is at most half the view across and down (`ImportContext.view`, below).
- **Commands:** `insert`, `set-style` (opacity), `crop` (`{id, crop}`, the crop kept inside the image and at least one pixel), `crop-reset` (the whole image again). A crop changes the data, the size and the position in one step: the new box is the old box's part that shows the new crop, turned about the old centre, so every pixel still shown stays where it was on the canvas, turned images included.
- **The crop tool** (`crop-tool`, key C): on the selected image, or on an image clicked with the tool, it shows the whole image dimmed outside the crop (unturned images; a turned image gets the shade alone, because the overlay only translates), the crop's outline and eight handles. Dragging a handle moves those edges within the image; release runs `crop`. Escape cancels a drag, then leaves the tool; Enter leaves it; a click beside any image leaves it.

### Importing in the editor

The editor did not import files before; 0005 section 6.1 described the flow and the extension interface had importers. It now does (`import.ts`):

- **Choosing an importer:** the first whose file types take the file's media type or name extension, else the first whose `sniff` recognises its first 4096 bytes. A file no importer takes is named in a notice.
- **One step:** the fragments of all files of one import are merged into one (each moved to its place) and pasted with the basics' `paste`, so dropping ten images is one undo step, and what was pasted is selected. Fragments with stops or routes are pasted one by one instead. At most 100 files per import.
- **Where:** centred on the drop point, or in the middle of the view; each further file 24 screen pixels down and right of the one before.
- **Drop:** the canvas accepts files dragged onto it.
- **Paste** (finishing what [0008](0008-selection.md) left open): when the clipboard holds no fragment of the program but files (an image copied in another program, files copied in a file manager), they are imported. Files only listed as items are taken too. The context menu's paste, which reads the asynchronous clipboard, first asks for its items and imports an image item; anything else goes the text way as before.
- **Picking:** the context menu has "Insert a file…", which opens the browser's file picker for the types the importers read.
- **Notices** from importers (labels with values) are shown in the editor's notice; `EditorNotice` gained `values` for that.

No new extension point was needed for pasting files: the importers are it, as for dropped and picked files. Pasting plain text as a text box belongs to the text extension.

### Changes outside the package

- **`packages/extension-api`:** `ImportContext.view?: Rect`, the part of the canvas the user sees when the import starts, so an importer can size what it makes to the view. Optional, so existing importers and hosts are unaffected. **It needs interface version 1.5**; the version is left at 1.4 here, for the orchestrator to raise when this is merged.
- **`packages/editor`:** the import flow, the asset store, the image source over stored versions, drop, paste of files, the file picker, `EditorOptions.assetStore`, `Editor.importFiles`, `canImport`, `importing`, `EditorNotice.values`, `EditorApp.imageStats` (reads of originals, for tests). Necessary: the editor is where files arrive and where the session lives.
- **`packages/renderer`:** `ImageLevel.scalable`, SVG decoding, `makeImagePreviews` and `previewSizes`, the statistic `originalLevelDecodes` (decodes of an original at any size; `originalDecodes` counts only full size).
- **`packages/core`:** nothing.
- **`apps/web`:** loads `galatsa.image` instead of the sketch, and the sample scene uses its type.

## Known limitations

- **The crop tool works in root space** (`ToolPointerEvent.world`), like the shape tools: under a camera anchored deep inside a frame far from the root, its handles are imprecise.
- **No aspect lock or panning in the crop tool.** Shift does not keep the proportions, and the image cannot be moved under a fixed crop; both are additions to the tool, not to the data.
- **EXIF orientation** is read for the natural size; that `ImageDecoder` and `createImageBitmap` apply it the same way in every browser is assumed, not tested.
- **GIF and AVIF** are not imported (the importer does not list them); an animated GIF would show its first frame.
- **A version-1 program from before this change drops the versions when it saves.** They are made again on the next opening, at the cost of decoding each original once, in the background.
- **Images with versions made in the background** are drawn from their original until the versions are there; for a shared file with many large images opened in WebKitGTK, that is the original-decoding cost 0004 measured, spread over time and limited to the images on screen.
- **Sync** (later) must carry the versions beside the assets, or every peer makes its own.
- **WebKit** (drop, paste, the picker, SVG drawing, JPEG/PNG versions) is not tested on this machine: Playwright's WebKit does not run here.
- **No progress or cancel** for long imports in the interface yet; `importing` says one runs.

## Rejected alternatives

- **Versions in the Y.Doc or `document.json`:** above.
- **Versions only in the program's cache:** above.
- **One preview per image** (a thumbnail): a 12-megapixel photo seen at 1000 pixels would then be decoded from the original. 0004 measured the cost.
- **A manifest field listing the versions:** a manifest field that must survive saving by an older version raises the minimum reader version (0001 section 9.4); self-describing entry names need none.
- **Hashing the versions** like assets: they have no identity of their own; the checksum catches damage, and a bad version only costs a picture at one size.
- **Raising `formatVersion` to 2:** it would say nothing a reader needs, and a version step without content is noise in the migration registry.
- **A separate paste extension point** for files: the importers already declare file types and sniff bytes, for drop and picking; pasting files is the same.
- **Cropping without moving the box** (the image is stretched to the box): what users expect from presentation programs is that cropping cuts the picture where it is.

## Tests

- `packages/format/src/previews.test.ts`: versions written beside the assets for the assets the file carries (external ones too) and read back smallest first, as views of the file's bytes, by both readers; the document the same with and without them, merge identity kept, nothing of them in `document.json`; sharing keeps the smallest, "all" and "none" on request; the file written without them when it would not fit; a source that throws costs the versions only; a file without versions opens as before; a reader with the old acceptance rule skips them; malformed names and damaged entries ignored without warnings; names parsed only when well formed; lists normalised (valid only, one per size, smallest first, at most 8). The property tests of the format ("save and open give the same document", random documents) run unchanged.
- `packages/storage/src/previews.test.ts`: stored beside the asset and handed out by size; found by another program; carried from the store into files and from files into the store and out again by `exportFile`; kept in memory when the store fails, saved into files from there, and stored later; removed with the slot; stray keys ignored.
- `packages/renderer/src/previews.test.ts`: the sizes of the versions; a scalable original offered at halves and multiples; SVG sent to its own decoder; the statistics.
- `packages/extensions/image/src/facts.test.ts`: PNG, JPEG with EXIF orientation (big and little endian), cut-off JPEG, the three kinds of WebP, SVG sizes from width and height, units, the viewBox and the default; bytes over type over name; absurd sizes refused; sniffing.
- `packages/extensions/image/src/image.test.ts`: reading valid, lenient and wrong data; importing a PNG sized to half the view with its description; the same file ten times stored once; notices for files that are not images or whose size cannot be read; insert as one step, opacity; crop keeping the shown part in place, clamped to the image, reset, refused when nothing changes, undone; refused for locked images and images of unknown size; the crop geometry keeps every pixel in place for a turned image; dragging edges; drawing.
- `packages/editor/src/import.test.ts`: the importer chosen by type, by sniffing, or none; two files pasted as one step, centred on the drop point and selected; the same image imported ten times is one asset and one set of versions; files no importer takes named in a notice; image files on the clipboard imported; nothing without an asset store; versions made once, only for images large enough, not for other media or unknown sizes, and a failing maker costs nothing else.
- `packages/editor/src/images.test.ts`: the versions and the original listed without reading the original; an image without versions drawn from its original and its versions made in the background; SVG as a scalable original; the session's methods called on the session.
- `tests/e2e/images.spec.ts`, Chromium and Firefox: the same image dropped five times and pasted five times is one asset with versions 256 and 512 (a file picked through the context menu imported too); a 12-megapixel JPEG zoomed into by 2⁵, held there while its original is decoded, and zoomed out, 300 frames; a document of 200 images saved as a file and opened draws all 200 from stored versions with no original read or decoded; an image and a cropped image, and the crop tool, compared with stored pictures by the canvas's pixels; the crop tool crops by dragging an edge, as one undo step.

Measured on the development laptop (Ryzen 7 PRO 7840U), headless, other work running, 1280 × 720:

|                                                                        | Chromium        | Firefox         |
| ---------------------------------------------------------------------- | --------------- | --------------- |
| 12 MP zoom: frames over 33 / 50 / 100 ms, of 300 (two runs)            | 0 / 0 / 0       | 0–1 / 0 / 0     |
| 12 MP zoom: longest frame, `render()` at most                          | 16.8 ms, 4.3 ms | 33.2 ms, 4.0 ms |
| 12 MP zoom: decodes, of the original at full size                      | 3, 1            | 3, 1            |
| 200 images opened: versions decoded, originals read, originals decoded | 200, 0, 0       | 200, 0, 0       |
