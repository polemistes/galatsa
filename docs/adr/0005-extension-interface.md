# 0005 Extension interface and command registry

- Status: proposed
- Date: 2026-11-27
- Code: `packages/extension-api` (`@galatsa/extension-api`: the interface, the extension host, the command registry; `@galatsa/extension-api/testing`: a recording drawing context for tests), `packages/extensions/examples` (`@galatsa/extension-examples`: sketches of the text, shape and image extensions), `setTypeVersion` in `packages/core/src/ydoc/ops.ts`

## Contents

1. Context and summary
2. Ids, labels, modes and versions
3. Element types
4. Commands and the command registry
5. Tools
6. Import and export
7. Transitions and comfort
8. Panels
9. Registration and lifecycle
10. Where the code lives, and dependencies
11. The three sketches
12. What the editor, the renderer and the player provide
13. Open questions and known limitations
14. Rejected alternatives
15. Tests

The key words MUST, SHOULD and MAY are used in their usual sense (RFC 2119).

## 1. Context and summary

Galatsa must be extensible from the start, and every tool is an extension against the same interface: text, shapes, images, freehand drawing, tables, charts, maps and media, and also the importers, exporters and transitions. The editor has a quick mode with the basic functions and an advanced mode with everything. Every change a user makes must be undoable, one action at a time. The document model ([0001](0001-document-model-and-file-format.md)) already fixes how elements are stored (a fixed envelope, opaque `data`, open `ext` slots, references in `refs`, assets by hash) and how undo works (`DocumentUndoManager`, creation in two transactions, `group()` for several operations). The renderer ([0004](0004-rendering-engine.md)) draws extension elements through a drawing context it provides. Translations ([0003](0003-translations.md)) come from message bundles, one namespace per extension.

This document specifies the seven extension points (element type, tool, import, export, transition, command and panel), the command registry, how commands relate to undo, and how extensions are registered. The interface is TypeScript types plus a small runtime: the host that loads extensions and the registry that runs commands.

There are no third-party extensions. All extensions are first-party code bundled with the program at build time; nothing loads code from files or the network at run time, and there is no security model for foreign code. The interface does not prevent adding one later. The interface has no extension point for AI features, and none of the code here calls a language model, a suggestion engine or anything similar.

| Topic           | Decision                                                                                                                                                                                                                       | Section |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Package         | A new package, `@galatsa/extension-api`, not part of `@galatsa/core`. Environment-agnostic: no DOM or Node types.                                                                                                              | 10      |
| Manifest        | Declarative: an extension lists everything it contributes, so the host checks it before activating it. `activate` and `deactivate` are optional hooks.                                                                         | 9.1     |
| Ids             | Every contribution has the id `"<extension id>/<name>"`, the form element types already use. Extension ids use the characters of a message namespace.                                                                          | 2       |
| Text            | Definitions hold message keys (`"namespace:key"`), never text. The host checks at load time that each key exists.                                                                                                              | 2, 9.2  |
| Modes           | Each tool, command, importer, exporter, transition, panel and property field says whether quick mode offers it (`quick: true`). Advanced mode offers everything.                                                               | 2, 4.5  |
| Element data    | The type's `read` is a total reader from `data` to the type's model, with reports; data is valid when reading reports nothing. The same reader checks data before a command writes it.                                         | 3.2     |
| Drawing         | Element types draw in their local box through a `DrawContext` with paths, fills, strokes, images by asset id, and text laid out by the renderer. The renderer owns transforms, precision, culling and image levels.            | 3.3     |
| Placeholders    | An element whose extension is missing, older than the element, or fails while drawing is drawn as a labelled box. It can be moved, stacked, grouped, locked, deleted and duplicated, not resized, rotated or edited.           | 3.7     |
| Layout versions | Readers read every older `typeVersion`. An element's data is upgraded only as part of a user's edit, in the same transaction as the edit, with `setTypeVersion`.                                                               | 3.8     |
| Commands        | Synchronous, run as one undo step inside `DocumentUndoManager.group()`; a command run by another command joins its step; a command that fails is taken back. Commands change the document only through core operations.        | 4       |
| Gestures        | A drag may run many commands that apply at once and become one undo step at the end; cancelling takes them back.                                                                                                               | 4.7     |
| Tools           | A tool turns pointer and keyboard input into commands, draws previews in an overlay, and never writes to the document itself.                                                                                                  | 5       |
| Import          | An importer returns a fragment (and stores asset bytes); the editor pastes it with one command. Asynchronous, cancellable, with progress.                                                                                      | 6.1     |
| Export          | An exporter gets the document already purged for sharing and an asset reader limited to what that document uses; it never sees the live document.                                                                              | 6.2     |
| Transitions     | A transition plans a camera motion from start to goal. Comfort settings come with every request, and the player's guard enforces reduced motion whatever the transition does.                                                  | 7       |
| Panels          | Either a list of fields (controls bound to values; changes run commands) or a custom view for a user interface binding, typed by declaration merging so the interface does not depend on React.                                | 8       |
| Lifecycle       | Dependencies by id, optional or required; activation in dependency order, otherwise in the given order; one failing extension is reported and left out with its dependents. API version: same major, minor at most the host's. | 9       |

## 2. Ids, labels, modes and versions

**Extension ids** are lowercase words separated by dots (`galatsa.text`), the pattern of a message namespace (`NAMESPACE_PATTERN` in `@galatsa/i18n`). That makes the id usable in three places without escaping: as the first part of an element type id (`galatsa.text/text`, the grammar of [0001](0001-document-model-and-file-format.md) section 3.2), as the first part of every contribution id, and as the message namespace.

**Contribution ids** are `"<extension id>/<name>"`, with the name in the characters an element type name allows (`a-z 0-9 . _ -`, starting with a letter or digit). An extension names its contributions; the host prefixes them, so two extensions can never collide, and ids within one extension must be unique per kind. Ids are stable: documents store element type and transition ids, and user settings will store command and tool ids (shortcut overrides, toolbars).

**Labels** are message keys `"namespace:key"` (type `Label`). A definition never holds user-visible text, only keys, and the editor looks them up with its `I18n` when it shows them, so a change of language needs no reload. `messageKey(bundle, key)` builds a label whose key the type checker verifies against the bundle. A label's namespace is one of the extension's own, one of its dependencies', or `common`.

**Modes.** `Mode` is `"quick"` or `"advanced"`. Every contribution that users see has an optional `quick` flag; quick mode offers what has `quick: true`, advanced mode offers everything, so quick mode is a subset. The flag lives on the definition, next to what it marks, and is the single source for menus, toolbars, the keyboard map, the command search, the property panel and the import and export dialogs (`availableIn(quick, mode)`). Running a command checks the mode too, so a shortcut cannot reach an advanced command in quick mode.

**Shortcuts** are strings such as `"Mod+Shift+Z"`: modifiers (`Mod`, `Ctrl`, `Alt`, `Shift`, `Meta`; `Mod` is Ctrl on Windows and Linux, Cmd on macOS) and a `KeyboardEvent.key` value. `normalizeShortcut` gives the canonical spelling (modifiers in a fixed order, a single letter in lower case).

**Interface version.** `EXTENSION_API_VERSION` is `{ major, minor }`, now 1.0. The minor version rises with every additive change (a new optional member, a new extension point); the major version rises with every incompatible one. An extension declares the version it was written against (`api`) and runs if the major versions are equal and its minor version is at most the host's.

## 3. Element types

An element type (`ElementTypeDefinition<M>`) is what an extension tells the program about the elements it defines. `M` is the type's _model_: the data as the type understands it. Every method except `read` takes the model, never the raw data.

| Member          | Required             | Purpose                                                                                       |
| --------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `name`, `label` | yes                  | Type id `"<extension id>/<name>"`; label for menus and the placeholder of an empty selection. |
| `typeVersion`   | yes                  | The newest layout of `data` this definition writes (3.8).                                     |
| `read`          | yes                  | Total reader from `data` to the model, with reports (3.2).                                    |
| `upgrade`       | if `typeVersion` > 1 | The data writes that bring an older layout up to date, applied with a user's edit (3.8).      |
| `draw`          | yes                  | Draws the element in its local box (3.3).                                                     |
| `bounds`        | no                   | The area drawn when it reaches beyond the box (3.4).                                          |
| `hitTest`       | no                   | Whether a point hits the element (3.4).                                                       |
| `textEditing`   | no                   | Where in-place text editing happens, for text-like types (3.5).                               |
| `references`    | no                   | Ids of elements and stops the data refers to (3.6).                                           |
| `assets`        | no                   | Assets the element shows (3.6).                                                               |
| `capabilities`  | no                   | Whether the user may resize and rotate it (3.7).                                              |
| `properties`    | no                   | Adjustable values for the properties panel (3.9).                                             |

Methods that take the model are written as methods, not function properties, so TypeScript compares their parameters bivariantly and the host can hold definitions of different models in one list (`AnyElementType`) without casts.

### 3.1 Where elements come from

Elements are created and changed only by commands (section 4). An element type defines no "create" method: its extension's commands build the initial data and call `insertElement`, which checks the data with the type's reader, writes it in the current layout and sets `refs` (3.6). Import builds elements into a fragment (6.1).

### 3.2 Data and validation

The document model keeps `data` opaque: the grammar reads its generic encoding (plain JSON and tagged shared types) and quarantines only what that encoding cannot hold ([0001](0001-document-model-and-file-format.md) section 2.1). What the data _means_ is the extension's, and the extension follows the same principle as the grammar, with one reading function:

- `read(data, typeVersion, report)` MUST be total: it never throws, whatever the data holds, because a peer, an older or newer version, or a damaged file may have written it. What does not fit is read as a default and reported (`report(path, problem)`). Reading the same data again reports the same things.
- Data is **valid** when reading it reports nothing. Before a command writes data, `insertElement` and `updateElementData` read the complete result with the type's reader and throw `InvalidDocumentError` with the reports if there are any, before anything is written. So a command can no more write data its own type would read differently than an operation can write what the grammar would change.
- `read` is pure, so the renderer and the editor MAY cache the model until the element's data changes.
- The patterns of [0001](0001-document-model-and-file-format.md) section 3.4 apply: independent properties are separate keys, values that belong together are one JSON value, edited text is a `Y.Text`, concurrent collections are maps keyed by random ids with order keys, derived data is never stored, large binaries are assets, references are complete string values listed in `refs`.

A schema language (JSON Schema, a validation library) was considered and rejected (section 14): the reader has to produce a model with defaults anyway, and a schema would be a second definition of the same thing.

### 3.3 Drawing

Element types draw through a `DrawContext` that the renderer provides; they never reach the canvas. The context is defined without DOM types, so the renderer implements it over Canvas 2D, and the player, a thumbnail or picture export, or a test can implement it otherwise (`createRecordingDrawContext` records calls).

- **Coordinates.** `draw(model, ctx, box)` draws in the element's local, unrotated box: (0, 0) is the top-left corner and (`box.w`, `box.h`) the bottom-right, in world units. The renderer applies position, rotation, containers and the camera.
- **Precision.** Paths are renderer objects built like Canvas 2D paths (`moveTo`, `lineTo`, curves, `arc`, `ellipse`, `rect`, `roundRect`). The renderer converts every point itself, in float64 and relative to the camera, and clips geometry far outside the screen before it reaches the canvas ([0004](0004-rendering-engine.md), "Camera-relative drawing"), so element types never deal with precision at deep zoom. For the same reason the context offers only translation (`withOffset`), not scaling or rotation.
- **Primitives.** `fill(path, color)`, `stroke(path, style)`, `withOpacity(alpha, draw)`, `withClip(path, draw)`, `withOffset(x, y, draw)`. Colours are CSS colour strings.
- **Images** are drawn by asset id: `drawImage(asset, dest, { crop })`. The renderer picks the stored reduced level that matches the size on screen and never decodes the original unless it fills the view ([0004](0004-rendering-engine.md), "Image levels of detail"). It returns `"drawn"`, `"loading"` or `"missing"`, so the type can draw its own stand-in; the renderer redraws when a loading image arrives.
- **Text** is laid out by the renderer: `layoutText(content, style, width)` returns an opaque `TextLayout` with its size, and `drawText(layout, x, y)` draws it. Content is a plain string or rich text in its JSON form (a `Y.Text` delta). The renderer computes line breaks once at a reference size and scales them, and the editing overlay uses the same breaks, so text does not jump when editing starts ([0004](0004-rendering-engine.md), "One text layout"). Font families are generic names that the renderer maps to the fonts it bundles.
- **Text the element itself shows** (a "missing image" label) is looked up with `ctx.t(label, values)`.

### 3.4 Bounds, hit testing and level of detail

- `bounds(model, box)` returns the drawn area in the local box when it reaches beyond the box (a thick stroke, a shadow); the default is the box. The renderer uses it for culling and redraw regions.
- `hitTest(model, point, box, tolerance)` decides whether a point in the local box hits the element, within `tolerance` world units (the renderer converts its pixel tolerance). The renderer calls it only near the bounds; the default is the box grown by the tolerance. The shape sketch tests the real outline (an ellipse is not hit in its corners).
- **Level of detail.** `ctx.scale` is device pixels per world unit at the element, and `ctx.detail` is the renderer's request: `"full"`, `"reduced"` (small on screen or a fast camera; leave out fine detail) or `"box"` (a few device pixels; a filled box in the main colour is enough). Elements under half a device pixel are not drawn at all. A type MAY ignore the hint; the text sketch draws a bar at `"box"`, as [0004](0004-rendering-engine.md) asks for text under about 4 device pixels.

### 3.5 Text editing

A text-like type implements `textEditing(model, box)`, returning the data key of its `Y.Text`, the text style, the text area in the local box, and whether the box height follows the text. The renderer's `beginTextEdit(id)` asks the type for this target, lays the browser's editing element over the area with the same style and line breaks, and binds it to the shared text. Typing goes through the editor binding's own transaction origin, which the document's undo manager tracks (`createUndoManager(doc, { origins })`), so typing and commands share one undo history; typing is grouped by the manager's capture timeout, and a command run during typing starts a step of its own. With `autoHeight`, the editor resizes the element when the laid-out height changes, in the same step as the typing that caused it.

### 3.6 References and assets

- `references(model)` lists the ids of elements and stops the data refers to. Whenever a command writes data through `insertElement` or `updateElementData`, the host sets the envelope's `refs` to this list (`setRefs` writes only the difference), so copy, duplicate and paste remap the references ([0001](0001-document-model-and-file-format.md) section 3.5). A reference MUST be stored as a complete string value equal to the id.
- `assets(model)` lists the assets the element shows. It is informational, for notices such as "3 images are missing": the document finds asset references by scanning for asset ids, so nothing is lost if this list is incomplete.
- A command that writes an asset reference MUST register the asset's description with `addAsset` in the same command, also when the description is there already ([0001](0001-document-model-and-file-format.md) section 8.3). `addAsset` is untracked and is not undone with the command, which is intended: tidy up removes unused descriptions.
- Asset bytes are hashed and stored before the command runs (section 4.3), through the host's `AssetStore`.

### 3.7 When the extension is missing

The host resolves every element (`host.resolve(element)`) to one of: handled by its extension; handled by core (frames and groups); or a **placeholder**, because no loaded extension defines the type (`"missing"`) or the element's `typeVersion` is higher than the type's (`"newer"`). An element whose type throws while drawing is drawn as a placeholder too (`"failed"`), so one faulty extension never breaks a frame.

A placeholder is drawn by `drawPlaceholder`: the element's box, filled lightly and outlined with a dashed line one device pixel wide, with the localized reason and the type id ("Missing extension: examples.chart/chart") when there is room. The renderer and the player use the same function.

What the user may do is decided by `host.capabilities(element)`:

| Element                      | Move, stack, reparent, group, lock, delete, duplicate, paste | Resize                     | Rotate                     | Edit content |
| ---------------------------- | ------------------------------------------------------------ | -------------------------- | -------------------------- | ------------ |
| Known type                   | yes                                                          | unless the type forbids it | unless the type forbids it | yes          |
| Placeholder (missing, newer) | yes                                                          | no                         | no                         | no           |
| Frame                        | yes                                                          | yes                        | no                         | yes          |
| Group                        | yes                                                          | no (no size of its own)    | no                         | yes          |

Resizing a placeholder is refused because the extension may tie the box to the content ([0001](0001-document-model-and-file-format.md) section 9.5, decided with the users). Content edits are refused by `updateElementData` itself, so no command can edit the data of a placeholder by mistake. The placeholder's data and `ext` are never read, never upgraded and never written; a file round trip keeps them unchanged. Unloading an extension turns its elements into placeholders on the spot; loading it again brings them back.

A transition whose extension is missing plays as the route's default, and its stored value is kept. Missing tools, commands, importers, exporters and panels are simply not offered.

### 3.8 Layout versions and upgrades

The policy is that of [0001](0001-document-model-and-file-format.md) section 9.4, made concrete:

- `read` MUST read every `typeVersion` from 1 to its own. It is never called with a higher one: such elements are placeholders and are never down-migrated.
- Data is **never upgraded on load**. A live document may mix layout versions of one type.
- An element's data is upgraded **only as part of a user's edit** of that element. `updateElementData` calls the type's `upgrade(data, from)`, which returns the keys to set, and applies those writes, the edit and `setTypeVersion` inside one `edit()`: one transaction, so peers never see the new version without the new data, and one undo step with the edit, so undoing the edit restores the old layout too. `setTypeVersion` never lowers a version.
- Upgrades SHOULD add keys rather than rewrite them, so that two users upgrading the same element at the same time converge. The text sketch shows this: version 2 added `fontFamily` and `align`, and the upgrade writes what version 1 implied.
- A definition with `typeVersion` above 1 MUST have `upgrade`; the host refuses it otherwise.

### 3.9 Properties and fields

A `FieldDefinition<S>` describes one adjustable value: a key, a label, a control (`number` with range and step, `color`, `select` with labelled options, `toggle`, `text`), a `quick` flag, a getter, and the id of the command that changes it. When the user changes the value, the editor runs that command with a `FieldChange` (`{ ids, key, value }`), so every change is one undo step and goes through the same checks as any other command. For several selected elements the editor reads each and shows a mixed state when they differ.

An element type lists its fields in `properties` (`S` is its model); the editor's properties panel shows them for the selection, filtered by mode (`host.properties(type, mode)`). This is how quick mode shows fewer adjustments than advanced mode on the same element: the shape sketch offers fill, outline and outline width in quick mode, and also the shape type, corner rounding and opacity in advanced mode. A value set in advanced mode stays in effect in quick mode; only its control is hidden.

## 4. Commands and the command registry

Every change a user makes to a document goes through a command: menus, toolbars, shortcuts, the property panel, tools, drag and drop, paste and import. A command (`CommandDefinition<A, R>`) has a name (id `"<extension id>/<name>"`), a label, an optional description, icon and shortcuts, a `quick` flag, `enabled` and `visible` predicates, an `undoable` flag, and `execute(ctx, args)`.

### 4.1 The context

The editor describes its state in a `CommandEnvironment` for each call: the `Y.Doc`, its `DocumentUndoManager`, the mode, the selection and the visible part of the canvas (where new elements go when the command is not told where). The registry adds `extensions` (element types and capabilities) and `run(id, args)` for running another command as part of this one. The environment is passed to every call rather than held by the registry, so the registry has no hidden state about the editor, works the same for several open documents, and is easy to test.

### 4.2 One command, one undo step

`registry.execute(id, env, args)`:

1. returns `{ ok: false, reason: "unknown" }` for an unregistered id, and `{ ok: false, reason: "disabled" }` if the command is not offered in the mode or `enabled` returns false (or throws);
2. otherwise runs `execute` inside `env.undo.group()`, which makes one undo step of everything the command does, whatever the capture timeout, and returns `{ ok: true, value }`;
3. a command run from inside another command (through `ctx.run`, or `execute` while one is running) runs directly and joins the outer step. This matters: `group()` closes the open step when it starts, so a nested `group()` would split the outer command into two steps;
4. a command with `undoable: false` runs without a step. It is for commands that do not change the document: the camera, panels, the mode, the selection, and undo and redo themselves.

Undo and redo are commands like the others (in the editor's built-in extension), so they have labels, shortcuts and quick-mode flags.

### 4.3 Rules for `execute`

- `execute` MUST be synchronous. `group()` spans a synchronous function, and an undo step that waited for a promise could swallow unrelated edits. Asynchronous work (reading a file, hashing an asset, decoding an image, an import) happens before the command runs, and its result is the command's argument.
- `execute` MUST change the document only through the operations of `@galatsa/core/ydoc` (and the helpers here that use them), with `edit()` for in-place edits of shared text and collections. It MUST NOT call `doc.transact`: the operations that create records (`addElement`, `group`, `addStop`, `addRoute`, `pasteFragment`, `importCopy`) refuse to run inside another transaction, because their first, untracked transaction must stay separate for undo to remove softly ([0001](0001-document-model-and-file-format.md) section 10); and a transaction with another origin would not be undoable or would not be recorded as work.
- Content edits use `updateElementData` (3.2, 3.8) and creation uses `insertElement`, so data is checked, upgraded and referenced the same way everywhere.
- Arguments SHOULD be plain JSON-compatible values, so that commands can be bound to shortcuts and menus and, later, recorded or scripted. `enabled` receives the arguments too, and SHOULD check them, because shortcuts and menus run commands without any.

### 4.4 A failing command leaves no trace

A command can fail midway: the operations check their arguments before writing, but a command of several operations may already have done some of them. If `execute` throws, the registry undoes the step the command had made and removes it from the redo stack, and returns `{ ok: false, reason: "failed", error }`. Undoing a creation removes softly, as always. Inside a nested run, the error propagates to the outermost command, which is taken back as a whole.

### 4.5 Quick mode

A command is offered in quick mode when `quick` is true. The registry lists commands per mode (`list(mode)`), builds the keyboard map per mode, and refuses to run a command that the current mode does not offer. Which commands are in quick mode is decided in each definition by the extension that owns it; the editor does not keep a second list.

### 4.6 Shortcuts

`registry.shortcuts(mode)` returns the keyboard map of a mode and the conflicts: when two commands offered in the mode claim the same shortcut, the first registered (in activation order) keeps it, and the conflict is reported so the editor can show it (`extensions:problem.shortcut-conflict`). A command not offered in a mode has no shortcut there; since advanced mode offers every command, two commands with the same shortcut always conflict there. User-defined shortcuts are a later addition on top of this map.

### 4.7 Gestures

A drag that moves or resizes elements should move them live (and, later, for collaborators too), yet be one undo step. `registry.beginGesture(env)` returns a `Gesture`: commands run through it change the document at once, and `commit()` makes one undo step of all of them (the undo manager's capture timeout is set to infinity between the two, the same mechanism `group()` uses within one call). `cancel()` takes everything back and leaves no redo step, for Escape or a lost pointer. After commit or cancel, the gesture runs nothing. Inside a gesture, a command that throws does not take back its partial changes (they are in the gesture's open step); the tool SHOULD cancel the gesture.

## 5. Tools

A tool (`ToolDefinition`) is the canvas-interaction part of an extension: a name, a label, an icon, shortcuts that pick the tool, a `quick` flag, a toolbar group, a cursor, and `start(session)`, which returns a `ToolHandler` when the user picks the tool.

- **Input.** The handler receives pointer events (`pointerDown`, `pointerMove`, `pointerUp`, `pointerCancel`) with the position on screen and on the canvas in root space, the pointer type, the button, the pressure and the modifiers, and key events (`keyDown`, `keyUp`, returning true when used). Events are plain objects without DOM types; the editor translates DOM events.
- **Output is commands.** A tool never writes to the document. It runs commands through the session (`session.run`, one undo step each) or through a gesture (`session.gesture()`, 4.7). The shape sketch draws a preview while the user drags and runs one insert command on release; the text sketch runs its insert command on click and asks the session to start text editing.
- **Overlay.** `drawOverlay(ctx)` draws previews (a rubber band, the outline of a shape being drawn) in root space above the document, with the same drawing context; the tool calls `session.requestOverlay()` when the preview changes. `ctx.scale` gives the size of a device pixel.
- **Session.** Besides running commands, the session gives the current editor state, hit testing, the zoom, cursor changes, `editText(id)` (the renderer's `beginTextEdit`), and `done()` to return to the default tool.
- **Modes.** Tools without `quick: true` are hidden in quick mode, with their shortcuts.

The selection tool, moving, resizing and rotating with handles, and snapping are tools and commands of the editor's built-in extension, written against the same interface. They use `capabilities` (3.7) to decide which handles an element gets.

## 6. Import and export

Importers and exporters share a `TransferContext`: a `Cancellation` (the host adapts an `AbortSignal` to it; `throwIfCancelled` and `CancelledError`) and `progress(fraction | undefined)`, where undefined means the amount of work is unknown. Both are asynchronous, so they can read and write large files without blocking, and both describe their file types (`FileType`: a label, media types and file name extensions) for file pickers, drag and drop and "save as".

### 6.1 Import

An `ImporterDefinition` has file types, an optional `sniff(head)` that recognises a file from its first bytes, and `read(source, context)`.

- **Whole or streaming.** The `ImportSource` gives the name, the media type and the size as the platform reports them, and both `bytes()` and `chunks()`, so each importer reads the file whole or as a stream, whichever suits it (an image needs all bytes; a long PDF can be read page by page).
- **Assets.** Images, video and fonts found in the file go into the host's `AssetStore` (`put` hashes the bytes and returns the asset id and description).
- **Result is content, not writes.** `read` returns an `ImportResult`: a fragment (the same structure copy and paste use, [0001](0001-document-model-and-file-format.md) section 3.5) and notices for the user (what was left out or approximated, as labels with values). The importer never touches the document. The editor pastes the fragment with one command (`pasteImport`, which uses `pasteFragment`), at the drop point or in the middle of the view, so the whole import is one undo step however large it is, and the document is resolved once rather than per element. `buildFragment` builds a fragment from new elements in their types' current layouts.
- **Choosing an importer.** `host.importersFor(file, mode)` lists the importers whose file types match the media type or name extension, in activation order; the editor uses `sniff` when that does not decide.

### 6.2 Export

An `ExporterDefinition` has one file type and `write(input, output, context)`.

- **Purged input.** The editor builds the input with `prepareExport(doc, assets, options)`: the document as a plain snapshot, **purged for sharing** (`purgeSnapshot`: removed content, revisions and delete marks gone, children of gone containers placed where the user sees them; [0001](0001-document-model-and-file-format.md) section 5.8), the route or selection to export, and an asset reader that serves only assets the purged document refers to. An exporter never sees the `Y.Doc`. So nothing that was deleted can leave the program through any export, whichever extension wrote it. (Saving the presentation itself is not an export; it is the file format's job. A shared `.galatsa` file is an export and is purged the same way.)
- **Output.** `output.write(chunk)` is called once for a whole file or many times for a stream; the host decides where the bytes go (a file, a download).
- **Pictures.** Exports made of pictures (PDF, a series of images, a video later) get `context.render`, which draws a region of the document (a rectangle in a container's space, like a stop's view) into an encoded image through the renderer and the element types, so the export looks like the canvas.
- **Result.** Notices, as for import.

## 7. Transitions and comfort

A stop's `transition` value ([0001](0001-document-model-and-file-format.md) section 6.1) is `{ "type": "<transition id>", "options": <JSON> }`, or null for the route's default; `readTransitionValue` reads it. A `TransitionDefinition<O>` has a label, a `quick` flag, `read(options)` (total, like an element type's) and `plan(request)`.

- **Request.** The start and goal as camera views in the same space (the player converts both to the space of their lowest common ancestor, so a flight between neighbouring stops deep inside frames stays precise), the options, the screen size and the comfort settings.
- **Motion.** `plan` returns a `CameraMotion`: a duration in milliseconds and `frame(time)`, which returns either a camera view or a cross-fade between two views with a mix from 0 to 1. At the end it shows the goal. The player calls `frame` on every animation frame; the motion is a pure function of time, so pausing, seeking and breaking out of a transition (the presenter takes over mid-flight) need nothing from the transition.
- **Comfort.** Some viewers feel unwell when the camera moves and zooms. `ComfortSettings` carries `reducedMotion` (from the system's setting, the user's setting, or the presenter's toggle during a presentation), the largest zoom ratio and distance a transition should still fly (above them it should cross-fade), and a duration scale. `DEFAULT_COMFORT` holds calm defaults until the users set their own. Every transition gets the settings and MUST honour them.
- **The guard.** The player wraps every motion in `guardComfort(motion, from, to, comfort)`. With reduced motion, any frame that would show a view other than the start or the goal becomes a cross-fade from start to goal; so no transition, faulty or not, can move the camera against the viewer's setting. Without reduced motion the motion is returned unchanged.

## 8. Panels

A `PanelDefinition` adds user interface to the editor: a name, a label, an icon, a `quick` flag, a location (`side`, `bottom` or `floating`), a `visible` predicate, and its content. The interface does not depend on React or any other user interface library; there are two kinds of content:

- **Fields** (`{ kind: "fields", fields }`): a list of field definitions (3.9) whose values are read from the editor context and whose changes run commands. Most panels (document settings, defaults, options of a tool) need nothing more, and the editor draws them in its own style, in both languages, accessible by keyboard, without the extension writing any user interface code. The text sketch's "Text defaults" panel is one.
- **Custom views** (`{ kind: "custom", binding, view }`): for panels that need their own interface (a map editor, a chart data table). `CustomPanelViews` is an empty interface that a user interface binding fills by declaration merging; the React binding will add `react: ComponentType<PanelProps>`. Until a binding does, a custom panel cannot even be written, so the interface package never refers to React, and the player, which has no React, never sees such panels.

Panels use the extension's message namespace for their text, like every other contribution.

## 9. Registration and lifecycle

### 9.1 The manifest

An `Extension` has an id, its own version (shown to users), the interface version it was written against (`api`), its dependencies, its message bundles, its contributions, and optional `activate` and `deactivate` hooks.

Contributions are **declared**, not registered from code: `contributes` lists the element types, tools, commands, importers, exporters, transitions and panels. So the host can check everything before activating anything, the editor can list commands and tools without running extension code, and a failing activation leaves nothing half-registered. `activate(context)` is for what needs code: preparing a cache, or checking whether an optional dependency is active. It is synchronous; an extension that needs to load data does so lazily, when first used, so starting the program never waits for an extension. `deactivate` releases what `activate` acquired.

### 9.2 Message namespaces

An extension's bundles are registered with the program's `I18n` when it is activated. Each bundle's namespace MUST be the extension's id or a whole-word prefix of it (`galatsa.shapes` for `galatsa.shapes.arrows`), so that several extensions shipped together can share one bundle, as the three sketches share `examples`. When several extensions share a namespace it stays registered until the last of them is unloaded. At load time the host checks every label in every contribution: its namespace must be the extension's own, a dependency's (the dependency's id or a whole-word prefix of it), or `common`, and a key in one of the extension's own bundles must exist. A typo in a label is therefore a load problem, not a missing text at run time.

### 9.3 Versions

An extension runs if its `api` major version equals the host's and its minor version is at most the host's (`isApiCompatible`). Dependencies name ids without version ranges, because all extensions are built and shipped together and cannot be out of step; ranges would only matter for third-party extensions, which are not planned.

### 9.4 Order and problems

`host.load(extensions)` checks each manifest (id, names, labels, namespaces, layout versions, field keys, interface version, duplicate ids), then activates the extensions one at a time: always the first, in the given order, whose dependencies are settled. So the order changes only where a dependency requires it, and activation order (which decides shortcut conflicts) is deterministic. A required dependency must be active (from this load or an earlier one); an optional dependency that is being loaded is activated first, and one that is absent or fails is no problem.

One extension's failure never stops the others. It is reported as a `LoadProblem` with a code and left out, together with every extension that requires it:

| Code                 | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `invalid`            | The manifest fails a check; `detail` says which.                 |
| `duplicate`          | An extension with this id is loaded already.                     |
| `api-version`        | Written for an interface version this host does not implement.   |
| `missing-dependency` | A required dependency is not there.                              |
| `dependency-failed`  | A required dependency was left out.                              |
| `cycle`              | Its required dependencies form a cycle.                          |
| `activate-failed`    | `activate` threw; its messages and contributions are taken back. |

`problemMessage(problem)` gives a user-facing message for each (`extensions:problem.*`, in both languages); `detail` is English for developers. The program goes on without the extension: documents that use it show placeholders (3.7).

### 9.5 Unloading

`host.unload(id)` unloads the extension and, first, every active extension that requires it, in reverse activation order: their contributions are removed, their message namespaces unregistered (unless still shared), and `deactivate` is called. Elements of their types become placeholders, with their data untouched. Development hot reload replaces an extension by unloading and loading it.

## 10. Where the code lives, and dependencies

The interface is a new package, `packages/extension-api` (`@galatsa/extension-api`), and not part of `@galatsa/core`:

- Core is the document model, used by the file format, the player and later the sync server. The extension interface brings in translations (labels, bundles), input events, panels and file import and export, none of which the document model needs, and a dependency on `@galatsa/i18n` would make every file of core subject to the hard-coded text check.
- The player needs element types, placeholders and transitions but no tools, commands or panels. It imports the types (erased at build time) and the runtime parts that need no Yjs (the host, `drawPlaceholder`, `guardComfort`). The helpers that write documents (`insertElement`, `updateElementData`, `pasteImport`, `prepareExport`) are in their own modules, and the package is marked free of side effects, so a bundler leaves them, and Yjs, out of the player.
- Like core, the package is environment-agnostic: no DOM or Node types. The drawing context, input events and file sources are described in plain types that the renderer and the editor adapt.

The package depends on `@galatsa/core`, `@galatsa/i18n` and `yjs` (13.6.33, already a dependency of core; used for types and for reading an element's facts). No new third-party package is added.

`packages/extensions/examples` (`@galatsa/extension-examples`) holds the sketches of section 11. It is a library in the extensions folder like the real extensions will be, with its own message folder, so the translation check covers its text.

Core gained one operation, `setTypeVersion` (3.8), because the envelope had no way to raise an element's layout version after creation.

## 11. The three sketches

The interface was checked by writing text, shape and image as extensions against it, in `packages/extensions/examples`. They are sketches: they use the real document model, the real host and real commands, and draw through the drawing context, but the text layout, image decoding and the editor around them are the renderer's and the editor's work. None of them needed anything the interface does not offer. (While writing them, two members were added to the interface before it was frozen: `withOffset` on the drawing context, because a tool overlay draws a template made for a local box at a position in root space, and gestures, because the selection tool will need live drags.)

| Sketch           | What it exercises                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `examples.text`  | Shared rich text (`Y.Text`) in `data`; text drawn through the renderer's layout; `textEditing` with `autoHeight`; detail level `box`; layout version 2 read and upgraded from version 1 on edit; quick and advanced properties; a tool that inserts and starts editing; a panel of fields bound to a document setting; an exporter (all text as a plain outline). |
| `examples.shape` | Shapes described as data (a template draws the outline and decides hits, and a new template adds a shape, its tool and its menu entry); bounds beyond the box; precise hit testing; quick and advanced properties; drawing tools with a preview overlay, Shift for a square, Escape to cancel, one command at the end.                                            |
| `examples.image` | An asset reference in `data`, registered with `addAsset` in the same command; drawing by asset id with a crop and a stand-in for missing bytes; an importer that reads a file whole, stores its bytes, reads the pixel size from a PNG header, reports progress, honours cancellation and returns a fragment.                                                     |

## 12. What the editor, the renderer and the player provide

The interface fixes what each side gives the other. The other side of each contract is built with the editor, the renderer and the player:

- **Renderer:** a `DrawContext` over Canvas 2D (camera-relative float64 paths, clipping, image levels, text layout with one layout for drawing and editing, `ctx.t`), calling `host.drawElement` for each visible extension element and drawing frames and groups itself; `bounds` for culling and `hitTest` for picking; `beginTextEdit` driven by `textEditing`; a `RegionRenderer` for exports.
- **Editor:** a `CommandEnvironment` per call; menus, toolbars, the keyboard map, the command search and the properties panel built from the registry and the host per mode; a `ToolSession` with gestures; translating DOM input to tool events; the import flow (choosing an importer, an `AssetStore`, progress and cancel, pasting with one command) and the export flow (`prepareExport`, output to a file); a field renderer for panels and properties, and the React binding for custom panels; a built-in extension with the envelope commands (move, resize, rotate, reparent, z-order, group, lock, delete, duplicate, copy and paste, undo, redo) and the selection tool, checking `capabilities`; showing load problems and shortcut conflicts.
- **Player:** the host with the element types and transitions, `drawPlaceholder`, and `guardComfort` around every transition, with comfort settings from the system and the presenter.

## 13. Open questions and known limitations

**For the users** (about how the program behaves):

1. Quick and advanced mode are fixed by the program: each function's place is decided where it is made. Should users later be able to move functions between the two modes themselves, or is a fixed split enough? (Suggestion: fixed for now; personal toolbars can come later.)
2. A value set in advanced mode (for example corner rounding) stays in effect when the user switches to quick mode, but its control is hidden there. Is that right, or should quick mode show such values when they differ from the default? (Suggestion: hide them, as now.)

**Known limitations:**

1. No third-party extensions: no loading of code at run time, no sandbox, no permissions. Adding them later needs a security model, and probably running foreign extensions in a worker, which this interface does not prevent (draw calls and commands are plain data and calls).
2. Commands are synchronous (4.3). A long operation that has to write a lot (an import of thousands of elements) builds a fragment first and pastes it with one command on the main thread. Pasting resolves the document once instead of once per element, which [0001](0001-document-model-and-file-format.md) section 11 recommends for bulk creation; how long a very large paste takes has not been measured.
3. Inside a gesture, a command that fails keeps its partial changes until the gesture is cancelled or committed (4.7).
4. The drawing context has no gradients, shadows, blend modes or patterns yet. Adding them is additive (a minor version), when an extension needs them.
5. `updateElementData` reads the element's data from the document for every edit. That is cheap for the planned types; a table with thousands of cells should edit its shared maps in place with `edit()` and check only what it writes.
6. Field controls are a small fixed set. New controls are additive.

## 14. Rejected alternatives

- **The interface in `@galatsa/core`.** It would make core depend on translations and carry user interface concepts the player and the server do not need (section 10).
- **Registering contributions from `activate` code** (as in some editors' extension systems). It allows lazy activation, which bundled first-party extensions do not need, and loses the check of the whole manifest before anything runs.
- **A schema language for element data** (JSON Schema or a validation library). The reader must produce a model with defaults anyway; a schema would be a second, possibly inconsistent, definition of the same data, and an extra dependency.
- **Migrating element data on load.** Rejected in [0001](0001-document-model-and-file-format.md) section 9.4: it would rewrite every element on every replica and lose merge identity; upgrades happen with edits instead.
- **Asynchronous commands.** An undo step that waits would capture whatever else happens meanwhile; doing the asynchronous part first and passing its result keeps one command one step.
- **Tools that write directly to the document.** Undo would then depend on each tool grouping its own writes correctly; with commands and gestures, the registry does it once.
- **Giving exporters the live document.** Each exporter would have to remember to purge, and one that forgot would leak deleted content. The host purges once, for all.
- **React components in panel definitions.** The interface package would depend on React, and the player and tests would carry it.
- **Version ranges for dependencies.** All extensions ship together; ranges add checks that can never fail.

## 15. Tests

- `packages/extension-api/src/host.test.ts`: activation in dependency order and otherwise in the given order; missing and failed dependencies and cycles reported, the rest loaded; optional dependencies; dependencies from an earlier load; duplicates; interface versions; manifest checks (ids, label namespaces, label keys, duplicate names, layout version without upgrade); an activation that throws leaves nothing behind and fails its dependents; unloading dependents first, with shared message namespaces kept until the last user goes.
- `packages/extension-api/src/command.test.ts`: a command that runs other commands is one undo step; separate commands are separate steps however fast they follow; unknown, disabled and nested-disabled commands; advanced commands refused in quick mode; commands that are not undoable; the keyboard map per mode with conflicts; gestures committed as one step and cancelled without a redo step; shortcut normalization.
- `packages/extension-api/src/transition.test.ts`: transitions found by the stored id; with reduced motion, no frame of even a careless transition shows a view other than start and goal; without it, motion unchanged.
- `packages/extensions/examples/src/examples.test.ts`, with the real document model: the three examples load without problems and offer their contributions per mode; inserting a text box is one undo step that undo removes and redo restores; a style change of several shapes is one step; data the type's reader rejects is refused before anything is written; a command that fails after inserting leaves no element and no redo step; version 1 text reads cleanly and is upgraded to version 2 in the same step as an edit, and undo restores version 1; text draws through the layout and as a bar when tiny; the text tool inserts and starts editing; the defaults panel reads and changes a document setting; the outline exporter does not export a deleted text; the shape tool previews without writing and inserts with one command, and Escape cancels; shape hit testing and bounds; inserting an image registers its asset in the same command, and missing bytes draw a stand-in; importing a PNG gives a fragment that one command pastes and undo removes; cancellation; elements of a missing extension and of a newer layout draw as labelled placeholders, can be moved with their data unchanged, and cannot be resized or edited; unloading an extension turns its elements into placeholders and loading it again brings them back.
- `packages/core/src/ydoc/type-version.test.ts`: `setTypeVersion` with data in one transaction and one undo step; it never lowers a version and refuses frames and groups.
