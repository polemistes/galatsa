# 0007 Editor foundation

- Status: Accepted
- Date: 2026-11-27
- Code: `packages/editor` (`@galatsa/editor`), `apps/web` (the development page), `setOverlay` in `packages/renderer`, Svelte components in the checks of `scripts/` (hard-coded text, workspace, license headers), `tests/e2e/editor.spec.ts`, `tests/e2e/webkitgtk/editor_check.py`

## Context

The document model ([0001](0001-document-model-and-file-format.md)), the renderer ([0004](0004-rendering-engine.md)), the extension interface ([0005](0005-extension-interface.md)) and the storage layer ([0006](0006-storage.md)) each specify what "the editor" provides. This is the first version of that editor: the core that owns a document and runs tools and commands on it, and a development page that starts it. Camera controls, the selection tool with handles, toolbars, the properties panel, in-place text editing and the shortcut editor come later, on top of this.

## Decision

### One document, one undo manager, work tracked from the start

An `Editor` edits one `Y.Doc`. Its constructor first calls `trackWork(doc)` (an edit made before the work tracker is attached is not recorded as work and loses against a concurrent delete, 0001 section 12, assumption 7; attaching twice does nothing), then creates the document's one `DocumentUndoManager` (`createUndoManager`) and takes the document's live resolver (`liveResolver`). Every command runs through the extension host's command registry with a `CommandEnvironment` of that document, that undo manager and the editor's services. Typing (later) will join the same history through the undo manager's tracked origins.

### The live resolver feeds the renderer

The renderer reads an `EditorScene`, a `SceneSource` over the live resolver. The editor subscribes to the live resolver and passes `added ∪ changed ∪ removed` of every `ResolvedChanges` to `renderer.applyChanges`, as 0004 asks. No snapshot is taken and nothing is resolved anew after an edit. Element records (type, layout version, data, size, rotation) are read from the `Y.Doc` when the renderer asks for them; data goes through the same `readData` as commands.

### Previews of gestures

A gesture's preview (0005 section 4.7) is laid over the live resolver by the scene source: positions, sizes, rotations and data values for the previewed elements, positions in each element's effective parent space. A previewed container moves its contents, because every offset through it (`offset(from, to)`) is shifted by the preview of the containers on the way (containers only translate, so the shift is the same in every space below). When a preview changes, the renderer is told to read the previewed elements and everything inside them again. The document is not written until the gesture commits, so a drag of any size is one command and one transaction, and the scene queries the tools use (`placement`, `bounds`) keep answering from the document, which is what a tool needs to compute the next preview from.

**No document changes during a gesture.** While a gesture is open, the editor refuses every command that changes the document (`undoable` not false) that the user runs by a shortcut, a menu or a tool (`Editor.run` answers "disabled"); commands that change nothing (select all) still run, and undo and redo already wait (0005 section 4.2). The registry alone would let such a command run as its own step (0005 section 4.7), but the drag then commits over what the command changed: Delete pressed during a move deleted the element, and the move then committed on the deleted element as an extra, invisible undo step. Refusing was chosen over cancelling the drag, because a key pressed by mistake then costs nothing; the user releases the drag and presses the key again.

### Overlays: a small addition to the renderer

Tools draw previews (a rubber band, the outline of a shape being drawn) through `drawOverlay(ctx)` in root space (0005 section 5), and the editor draws the selection outline. The renderer had no place for this, so it gains `setOverlay(draw)`: a function called after the document in every frame on screen, with the renderer's own drawing context in **screen space** (CSS pixels of the drawing area; `ctx.scale` is device pixels per CSS pixel). It is never drawn by `renderRegion`. A function that throws is left out of that frame. This is an additive change to the renderer's interface (0004 is updated).

The overlay is in screen space so that its contract does not depend on where the camera is anchored. The editor draws the selection outline from the renderer's screen rectangles (`screenBounds`) directly. A tool still draws in root space, as its pointer events give it; the editor hands it a drawing context that projects root space onto the screen (`projectedContext`), with a projection (`Editor.projection(space)`: screen = point × scale + offset) computed from the offset between that space and the camera's own space, as the renderer computes its own maps, never through root coordinates. So when the camera is anchored in a frame's space for deep zoom, the overlay interface stays as it is, and a tool or the selection can be projected from the frame's space exactly.

**Precision of `ToolPointerEvent.world`.** Pointer events give tools a position in root space (0005 section 5). Under a camera anchored in a frame far from the root and zoomed deep, root coordinates cannot resolve a screen pixel (0001 section 7). Settled with the camera controls ([0009](0009-camera.md)): pointer events also carry the position in the camera's own space (`local`), and the scene query gives offsets between spaces; the overlay does not depend on it.

### Editor services

The services of 0005 section 4.8 are implemented over the editor's state and the live resolver:

- **Clicks** ask the renderer (`hitTest`), so a click hits what each element type says is its outline. What a click inside a group selects is the editor's decision: the outermost group the element is in, up to the nearest frame. Locked elements are passed over (a right click, which opens the context menu, does select them, so they can be unlocked: [0008](0008-selection.md)).
- **Rubber bands and bounds** answer from the live resolver: the elements at the top level of the canvas as the user sees it (members of a dissolved group in its place).
- **Visible elements** (candidates for snapping) come from the renderer's spatial index, at the top level of the root.
- **Text** is edited in place since [0011](0011-text.md); the service reports the text being edited and its selection.
- **The selection** is pruned when an element it holds goes away (an undo of its creation).

### Tools

A `ToolController` holds the current tool and gives it a `ToolSession`. A session whose tool has been put away does nothing, so a tool that keeps a reference cannot act after it is stopped. `done()` returns to the default tool after the event that ended the tool's work has been handled. A tool that throws is reported and the editor goes on.

### Input

`mountEditor` turns DOM events into the editor's plain input (`PointerInput`, `KeyInput`), so the core runs without a page and is tested in Node over a context that draws nothing:

- Pointer events cover mouse, pen, touch and trackpad clicks. The first pointer that goes down belongs to the tool until it goes up (with pointer capture); a second finger turns a touch into a pinch of the canvas ([0009](0009-camera.md)), and other further pointers are ignored.
- The camera: the middle button drags the canvas, the wheel scrolls it, and the wheel with Ctrl or Cmd, which is also what browsers send for a trackpad pinch, zooms about the pointer. The camera controls (anchoring in frames, Space with a drag, two fingers, Safari's gesture events, the keyboard) are in [0009](0009-camera.md).
- Keys go to the editor while the canvas has focus; it takes focus when clicked.

### The keyboard map

A key press goes first to the current tool (Escape cancels its drag), then to the keyboard map of the current mode: the command registry's shortcuts (`shortcuts(mode)`), then the tools' shortcuts, which pick a tool. A shortcut runs its command the way a menu would: with the selection as its elements (`{ ids }`), except copy, cut and paste: Mod+C, Mod+X and Mod+V are left to the browser (their default is not prevented), which sends its copy, cut and paste events, and the page passes those to the editor (`clipboardCopy`, `clipboardCut`, `clipboardPaste`). So the system clipboard carries the fragments ([0008](0008-selection.md)), and can carry pasted images later. When a shortcut matches, the browser's default is prevented even if the command is disabled, so that Ctrl+D with nothing selected does not open the browser's bookmark dialog. Shortcuts written with `Ctrl` mean the same as `Mod` on Windows and Linux.

A key press may name a shortcut in more than one way; the candidates are tried in order:

1. By the character the key gives (`KeyboardEvent.key`), with the modifiers. AltGr is not a modifier of the shortcut and is never read as Ctrl+Alt: where the system reports it as `AltGraph`, Alt is left out, and on Windows, which reports AltGr as Ctrl and Alt together, both are. A press with Ctrl and Alt counts as AltGr when it gives a character that is not a letter or digit (`{`, `@`, `€`; some browsers do not report `AltGraph`), and as a real Ctrl+Alt when it gives a plain letter or digit. On Linux, `Mod+[` on a Norwegian keyboard is then Ctrl+AltGr+8; on Windows, where Ctrl+AltGr cannot be told from AltGr, it is Ctrl and the key right of P (below).
2. By the key's place (`KeyboardEvent.code`), named as on a US keyboard, for punctuation and digits only, and only where the character cannot name the shortcut: where the key gives a letter on this layout, or Shift changed the character. So `Mod+Shift+]` works on a US keyboard, where Shift+] gives `}`, and `Mod+[` is also Ctrl and the key right of P (Å on a Norwegian keyboard). A character of its own wins: Ctrl and + on a Norwegian keyboard is `Mod++`, never the `Mod+-` of that key's place on a US keyboard (which would zoom out where Ctrl+Plus should zoom in), and a character AltGr gave (`{` on AltGr+7) never falls back to the digit. A dead key with Mod (¨ right of Å on a Norwegian keyboard) is matched by its place too, so `Mod+]` is Ctrl and that key ([0014](0014-stacking-and-frames.md)); alone, or with AltGr, it names nothing. Letters are not matched by place, so Ctrl+Z is the key marked Z on every Latin layout.
3. On macOS with Option, letters by place too, because Option changes the character a letter key gives.

This settles the matching part of 0005 section 13, "Can wait" 1, as far as the editor foundation needs. Not settled: whether the shortcuts the basics chose are good ones on a Norwegian keyboard and on macOS, conflicts that only show on one layout, and user-defined shortcuts. Those belong to the shortcut handling of the editor shell.

### Storage

`EditorApp` starts the program the way 0006 section 7.1 asks:

- The store is IndexedDB; checkpoints are built in a worker (`workerEncoder` over the program's worker, which imports `@galatsa/storage/checkpoint-worker`). If IndexedDB cannot be opened, the program works on a memory store and says that nothing is stored automatically; if the worker cannot start, checkpoints are built on the editing thread.
- At start, work left by a program that stopped is offered with the choices of 0006 section 7.1: restore, not now, keep without asking again, and either discard the changes (only for a document saved to a file; the user picks the file, since no file handle is kept yet, and the stored copy goes only after the file opened) or delete the presentation (only for one never saved to a file, after the text that says what is lost and a second confirmation).
- `EditorDocument` follows one open document: the save status, the storage layer's notices until dismissed, saving as a file (`pickFileToSave`, which falls back to a download), and a warning before the window closes while changes are not stored. Persistent storage is asked for (`requestPersistentStorage`) once per run, when the first change is waiting to be stored.
- **Closing.** While closing, the program says so. If the store has a problem, the offer to save as a file comes at once. If changes are only waiting for their turn (`status.pending`), they are stored first (a flush, which normally takes well under a second, waited for at most five seconds) and the offer comes only if that does not clear them, so that closing right after an edit does not always ask; this is our reading of 0006 section 7.1, whose aim is that nothing unstored is closed without the offer. Then `close()`; if it answers that not everything reached the store, the offer comes. After the offer the user can save as a file (the document then closes, since the file holds everything), close without saving (`close({ evenIfUnstored: true })`), or keep the document open.

### The interface: Svelte

The user interface around the canvas is Svelte 5, with runes, chosen by the project: Svelte compiles components to direct updates of the elements that depend on a changed value, without a virtual DOM to compare, so interface updates are small and fast, and the runtime the program ships is small. It is mounted with Svelte's `mount` into its own element over the canvas (`renderEditorUi`), and holds the save status, notices, the close and recovery dialogs, extensions that were not loaded and shortcut conflicts, and open custom panels. The components read the editor's own stores (the program, a document, the editor, the translations) through `Watched`, a small adapter over `createSubscriber` from `svelte/reactivity`, so the stores stay plain TypeScript that the tests run in Node. All text comes from message bundles (`editor` for the editor's own, `storage` for the storage layer's), in Norwegian and English, and changes with the language. The Svelte binding for custom panels adds `svelte?: Component<PanelProps>` to `CustomPanelViews` by declaration merging (0005 section 8); `PanelProps` gives the panel the command context and the program's translations (`i18n`, added with [0013](0013-routes-and-stops.md)). No binding for other UI libraries is built. Panels of fields need the field renderer and are not drawn yet. There is no toolbar and no properties panel yet.

**Tooling.** `@sveltejs/vite-plugin-svelte` compiles the components in the web app and in Vitest; `svelte-check` checks their types in the editor's `typecheck` (warnings fail it); `eslint-plugin-svelte` and `prettier-plugin-svelte` lint and format them. The TypeScript compiler alone sees an import of a `.svelte` file through the declaration Svelte ships for `*.svelte`. The web app compiles the editor's components from source, like the rest of the workspace; the editor's own build runs `tsc` alone. The package marks `.svelte` and `.css` files as having side effects, so a bundler keeps the components' styles.

**The hard-coded text check** reads components with `svelte/compiler`'s parser. Text in the markup, text attributes and component props (the same names as in JSX, with the same leniency for names that hold text only by convention), `{@html}`, the value of button-like inputs and actions named like text (`use:tooltip`) are text places. The `<script>` blocks and every expression of the markup (handlers, block conditions, `{@const}`) are checked as one TypeScript script with the rules of `.tsx` files, so a markup expression follows the script's constants and functions, and an `alert("...")` in a handler is found as in JSX; `$state` and `$derived` are followed like their value. `<!-- i18n-ignore: reason -->` works in markup. A component the parser rejects is reported. The workspace check reads the scripts, styles and element paths of components, and no package that Node runs from source may reach one.

### The development page

`apps/web` is for now a development page: it starts `EditorApp` with the sketches of the element types (and the basics and the selection tool, which the editor always loads first, so they keep their shortcuts when a sketch claims the same one; the conflict is shown; the selection sketch is left out, [0008](0008-selection.md); the shape sketch is replaced by the shape extension, [0010](0010-shapes.md)). It opens the sample scene: the benchmark scene of `bench/` (2,000 elements in ten clusters) as a document of the examples' element types, imported through the storage layer as a file. The benchmark's images are 2 to 12 megapixels and take half a minute to generate, so each gets a small generated picture of the same proportions instead. The page remembers the stored copy and opens it again; `?fresh` makes a new one, `?scene=empty` starts an empty document, `?lang=nb|en` chooses the language and `?mode=advanced` the mode. `window.galatsaDev` gives tests and the console the running editor. `shapes.html` is a second page, the shape gallery of [0010](0010-shapes.md). The page depends on `@galatsa/bench` for the scene; when the page becomes the installable web app, the sample scene goes behind a development switch.

Images are drawn from the storage session's asset bytes, one stored version each (the original), until reduced versions are stored with the document.

## Assumptions

- Nobody else writes to the document while a gesture runs in a way that moves the elements being dragged; if someone does (another tab), the preview shows the drag from the old place until it commits. There is no sync yet; showing collaborators' drags is presence, later (0005 section 4.7).
- The editor runs on the main thread with one document per editor. Several documents in one window are several editors.
- One `Editor` per `Y.Doc` at a time: the editor detaches the document's live resolver when it is disposed.

## Known limitations

- In-place text editing came with [0011](0011-text.md).
- Only the first pointer is the tool's; a second finger moves the camera ([0009](0009-camera.md)).
- Field panels are not drawn.
- The development page's sample scene is regenerated per `?fresh`, and every copy stays in the store until deleted (0006 section 11, item 4).
- Opening another document (a restored offer) disposes the editor of the one before but does not close its storage session, and a second click on a recovery choice while the first is still running can open the default document twice.
- In the recovery dialog, a problem from a failed restore stays shown with the next offer, and discarding that ends in "the document is open" or "never saved to a file" shows no message.
- A preview of a container reads every element inside it again on each pointer move, although their positions in the container do not change: about 29 ms per move for a frame with 5,000 elements (measured in Node, without drawing).
- The Svelte components have no tests of their own in a browser; the end-to-end test covers the status bar only.
- The list of load problems is keyed by extension id, so two problems for the same id would break it.
- Keyboard layouts without Latin letters (Russian, Greek): Ctrl+Z gives the layout's letter, so letter shortcuts do not match (only copy, cut and paste are found by place).
- On Windows, Ctrl together with AltGr cannot be told from AltGr alone; `Mod+[` on a Norwegian keyboard is Ctrl and the key right of P there.

## Tests

- `packages/editor/src/editor.test.ts` (Node, over a real document and the example extensions): work tracking on a document that came as an update; a shape tool used with pointer events and the default tool back afterwards; undo with Ctrl+Z and redo with Ctrl+Shift+Z and Ctrl+Y; a drag previewed without writing (the renderer shows the preview, the document and its updates unchanged, undo refused during the gesture), committed as one step and at most two updates, and undone; Escape cancels without writing; a frame's preview moves what is inside it; shortcut commands on the selection, copy and paste, Delete, and the basics keeping Ctrl+A; click and rubber-band selection and drawing the overlay; a click selects the outermost group; undo prunes the selection; a refused command writes nothing.
- `packages/editor/src/keymap.test.ts`: shortcut candidates on Windows/Linux and macOS, Shift with punctuation, AltGr on Linux and Windows, Mod+[ on a Norwegian keyboard, letters not matched by place except with Option on macOS, modifiers and dead keys, Ctrl spelled Mod.
- `packages/editor/src/document.test.ts` (memory store): closing when everything is stored, with the closing phase shown and persistent storage asked for once; the offer to save as a file when the store is full, saving, and closing afterwards; keeping the document open; the suggested file name.
- `scripts/lib/i18n-svelte.test.ts`: the hard-coded text check on components: markup text, text in braces and attributes with lines and columns; attributes mixing text and expressions, `{@html}`, button values and `<title>` in `<svelte:head>`; component props by the JSX names, codes left alone only where a name holds text by convention; translated text, symbols, numbers, keys, URLs, classes and directives left alone; comments, CSS, imports and types not read as text; constants, objects, functions, `$state` and `$derived` followed from the script; prop defaults, `{@const}` and text names in the script; handlers, blocks, snippets and `{#await}` checked as code; a module script; parameters and imports not followed; `i18n-ignore` in markup, in the script and in an expression, with a reason required and only real comments counting; `i18n-ignore-file` in either; a component the parser rejects reported. `workspace.test.ts` and `i18n-config.test.ts` cover the references of components and which files and packages are interface code.
- `packages/renderer/src/overlay.test.ts`: the overlay is drawn after the document in CSS pixels of the screen with the device scale, at the same place whatever the camera, is left out after `setOverlay(null)`, and a throwing overlay does not break the frame.
- `packages/editor/src/overlay.test.ts`: a projected context maps paths, widths, dashes and offsets from a document space to the screen; the editor's projection of root space follows the camera, and the projection of a frame's space under a camera anchored in that frame, 2^40 units from the root at zoom 2^30, is exact.
- `tests/e2e/editor.spec.ts` (Playwright): the development page opens the sample scene (2,000 elements); the rectangle tool, picked with R, draws a shape with the mouse and the canvas shows its fill; Ctrl+Z, Ctrl+Shift+Z, Ctrl+Z and Ctrl+Y undo and redo it; the selection tool drags it, the renderer shows it moving during the drag, and Ctrl+Z takes the move back; the save status is shown; no errors in the console. Runs in Chromium and Firefox (`chromium` and `editor-firefox` projects), and in WebKit (`editor-webkit`) where Playwright's WebKit can run: in CI, or with `E2E_WEBKIT=1`.
- `tests/e2e/webkitgtk/editor_check.py`: the same steps in the system's WebKitGTK (the engine of the Linux desktop app), with real mouse and keyboard input sent to the X server with xdotool, under Xvfb.

## Rejected alternatives

- **Writing previews into the document** (and undoing them): every pointer move would be a document update and work on the elements (0005 section 14).
- **A preview service inside the renderer** (`setPreview`). The scene source already stands between the document and the renderer; laying the preview over it there needs no change to the renderer, and the renderer keeps reading one source.
- **Drawing overlays on a second canvas** above the renderer's. It would need a second implementation of the drawing context, or exporting the renderer's internal one; and the two canvases would have to agree on size and device pixel ratio.
- **Matching every shortcut by key place** (`KeyboardEvent.code`), as some editors do. Ctrl+Z would then be Ctrl+W on a French keyboard. Matching letters by character and punctuation also by place gives the expected letter shortcuts on every layout and still reaches bracket shortcuts.
- **React** for the interface. The first version of this foundation used it; Svelte was chosen instead, for smaller and faster interface updates without a virtual DOM.
- **A framework-neutral panel binding** (custom elements, or a mount function per panel), so panels could be written in any library. Not wanted by the users; the Svelte binding is the only one.
- **A component library or a state library.** The interface so far is a status bar and two dialogs; plain Svelte over the editor's own stores is enough, and adds nothing to review.

## New dependencies

Licenses compatible with GPL-3.0-or-later; versions at least two weeks old on 2026-11-27 (publish dates from the npm registry).

| Package                                                                                    | Version | Published  | License | Why                                                         |
| ------------------------------------------------------------------------------------------ | ------- | ---------- | ------- | ----------------------------------------------------------- |
| [svelte](https://www.npmjs.com/package/svelte)                                             | 5.57.3  | 2026-10-26 | MIT     | The editor's user interface; its parser for the text check. |
| [@sveltejs/vite-plugin-svelte](https://www.npmjs.com/package/@sveltejs/vite-plugin-svelte) | 7.3.1   | 2026-09-23 | MIT     | Compiles components in the web app and in tests.            |
| [svelte-check](https://www.npmjs.com/package/svelte-check)                                 | 4.7.8   | 2026-11-01 | MIT     | Type-checks components.                                     |
| [eslint-plugin-svelte](https://www.npmjs.com/package/eslint-plugin-svelte)                 | 3.24.1  | 2026-11-07 | MIT     | Lints components.                                           |
| [prettier-plugin-svelte](https://www.npmjs.com/package/prettier-plugin-svelte)             | 4.1.1   | 2026-06-15 | MIT     | Formats components.                                         |

Their own dependencies are in the lockfile; `pnpm check:licenses` and the release-age check pass on them.
