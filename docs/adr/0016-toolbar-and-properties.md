# 0016 Toolbar and properties panel

- Status: proposed
- Date: 2026-11-27
- Code: `toolbar`, `active`, `CommandRegistry.toolbar` and `CommandRegistry.isActive` in `packages/extension-api`; `Toolbar.svelte`, `toolbar.ts`, `Properties.svelte`, `properties.ts`, `Icon.svelte`, `icons.ts` and `editorChanges` in `packages/editor/src/ui`; `EditorApp.openFile` and `EditorApp.setStageInsets` in `packages/editor`; `pickFileToOpen` in `packages/storage`; the toolbar button of the routes panel (`packages/extensions/routes`) and the crop tool's icon (`packages/extensions/image`); the first page and the base path of `apps/web`; `tests/e2e/shell.spec.ts`

## Context

The users want to try the program in a browser as soon as possible, from a public copy on GitHub Pages, together with a partner on Windows. They are not technical and do not know the shortcuts, so everything must be reachable with the mouse: making text, shapes, images and frames, making a route of stops, presenting, and saving to and opening from a file. Until now the editor had no toolbar and no properties panel ([0007](0007-editor-foundation.md)): tools were picked with keys, styles could not be changed at all, and opening a file was only reachable from the recovery dialog. The development page opened the benchmark scene of 2,000 elements.

This is the first part of the editor shell (F1-16): a simple toolbar and a simple properties panel, opening and saving files, and an empty presentation on the first visit. The command search, checking shortcuts for collisions and the strip of thumbnails come in the second part.

## Decision

### The toolbar is built from the registry

The toolbar (`Toolbar.svelte`, with its contents computed in `toolbar.ts` so they are tested in Node) shows, in the current mode:

1. **The tools**, grouped by their `group` (a tool without one stands alone), in activation order: selection, text, the shape kinds, the crop tool. The current tool's button is pressed (`aria-pressed`). A tool added by another extension appears without a change here.
2. **Insert an image from a file**: a file chooser accepting what the importers read (`acceptFor`), whose files go through `Editor.importFiles` like a drop. It is shown when the editor has an asset store and an importer.
3. **Undo and redo**: the basics' commands. Their buttons belong to the editor ([0005](0005-extension-interface.md) section 12.1: the basics have only commands; the buttons and keys that run them are the editor's), so the editor places them without the basics declaring anything.
4. **Every command that asks for a button**, by its toolbar group: see the next section. The routes panel's toggle is the first.
5. **Open a presentation file** and **save as a file**.
6. **The language**: Norwegian or English, switched at once (the page's title and `lang` follow).

A command's button runs it as a shortcut does (`runFromShortcut`: the selection as its `{ ids }`) and gives the canvas the keyboard back, so that undo and the tools' keys work right after a click. A button is greyed out when `Editor.isEnabled` refuses the command with those arguments, and hidden when `visible` says so. Every button has a tooltip (`title`) with its label, or the command's `description` where it has one, and the shortcut that reaches it in the current keyboard map, written as the keys are marked: `Ctrl+Skift+Z` in Norwegian and `Ctrl+Shift+Z` in English on Windows and Linux, `⇧⌘Z` on macOS. The names of keys (Skift, Mellomrom, Tilbaketast) are message keys. The toolbar updates when the selection, the tool, the mode, the panels, the document or the undo stacks change (`editorChanges`).

### `toolbar` and `active` on commands

Two optional members are added to `CommandDefinition`:

- `toolbar?: string`: the toolbar group the command has a button in. Commands with the same group stand together; groups come in the order their first command was registered. `registry.toolbar(mode)` lists them per mode; the editor asks `visible` and `isEnabled` when it draws.
- `active?(ctx): boolean`: for a command that switches something on and off, whether it is on now, so its button shows as pressed. `registry.isActive(id, env)` asks it, and is false for a command without it or one that throws.

Both are additive and raised the interface to 1.7, together with the presentation service of [0015](0015-presentation.md).

**For the packages built at the same time:** the command that puts a frame around the selection (F1-07) and the command that starts presenting (F1-14) get their buttons by setting `toolbar` (and `icon: "frame"`, `icon: "present"`, which the icon set has). The end-to-end test makes a frame through a toolbar button whose command id contains `frame`, when there is one.

### Icons

The icons are the program's own: one SVG path each on a 24 × 24 grid, drawn with a 2 px round stroke in the text colour (`icons.ts`), made for Galatsa and covered by the program's licence (GPL-3.0-or-later). No icon library is used. A contribution names its icon with `icon` (an `IconRef`, 0005 section 2); without one, the toolbar looks up the contribution's name (the part of its id after the slash: `galatsa.shape/rect` is `rect`), and falls back to a dot. The set has `select`, `text`, the shape kinds (`rect`, `ellipse`, `triangle`, `line`, `arrow`, `speech-bubble`, `bracket`), `crop`, `image`, `frame`, `route`, `undo`, `redo`, `present`, `open`, `save` and `language`. Extensions that bring icons of their own (0005 section 2) are not supported yet; none does.

### The properties panel

The properties panel (`Properties.svelte`, contents in `properties.ts`) shows the fields of [0005](0005-extension-interface.md) section 3.9 for the selection, or for the text being edited in place (which is outlined, not selected):

- **One section per element type** among the selected elements, headed by the type's label and, for several elements, how many. Elements of a missing extension, frames and groups have no fields and add no section; with nothing to show, the panel says how to get properties.
- **Fields** come from `host.properties(type, mode)`, so quick mode shows fewer than advanced mode; a field is shown only when its `applies` holds for every selected element of the type (the shape type's fill only for closed outlines, corner rounding only for kinds with corners).
- **Mixed values.** When the elements' values differ, the control shows it: an empty number or text box with "Mixed" as its placeholder, an extra "Mixed" entry in a choice, an indeterminate checkbox, and "Mixed" beside a colour, which shows the first element's colour.
- **Controls:** a number box (the value is kept within the field's range; the unit follows it), a colour input (with a "None" checkbox where the colour may be none), a choice, a checkbox, a text box.
- **Every change runs the field's command** with a `FieldChange` (`{ ids, key, value }`), as one undo step. A colour being dragged in the browser's colour picker is previewed through a gesture (0005 section 4.7: the document is not changed) and committed once when the picker reports the final value, so a drag is one undo step. A number is committed when the box reports a change (Enter, leaving the box, the arrows).
- More than 500 selected elements are not read (select all on a large canvas); the panel then shows its hint.

### Opening and saving files

- **Save as a file** runs the storage layer's save ([0006](0006-storage.md) section 6): with the File System Access API (Chromium, Edge) the user chooses a file and it is written in place and read back; elsewhere (Firefox, Safari) the file is a download, and the status says it still counts as not saved. Images go into the file with their reduced versions (the session's `saveToFile` collects every asset the document uses).
- **Open a presentation file** picks a file (`pickFileToOpen`: the File System Access API where there is one, otherwise a file chooser) and opens it with `EditorApp.openFile`: the file becomes a new stored document, the open one is stored (a flush, waited for at most five seconds) and its session closed, and the editor shows the new one. A file that cannot be opened leaves the open document as it was and shows why.
- **When the open presentation has changes not saved to a file**, opening asks first ("Open another presentation?"): save as a file, open without saving, or cancel. A closed presentation stays in the browser's storage, but nothing in the program lists stored presentations yet, so without the question its work would be out of reach. After a download the dialog says when it was downloaded, since only the user knows whether the file was kept.
- **A file chooser's `cancel` may come before its `change`.** Firefox driven by Playwright does this; `pickFileToOpen` resolved to "nothing chosen" on the cancel and never saw the file. A cancel now counts only when no file follows within a second, and the hidden control is put in the page while the chooser is open.

### The first visit

The web page opens a new, empty presentation. The sample scene (the benchmark scene, 2,000 elements) opens with `?scene=bench` (and a new copy of it with `?fresh` as before); the end-to-end test of the development page and its WebKitGTK check use it. `?scene=empty` is no longer needed but still gives an empty presentation. Work a closed tab left behind is still offered at start ([0006](0006-storage.md) section 7.1).

### Layout

The toolbar is a bar across the top of the window and the properties panel a column at the left, under it; the canvas fills the rest (`EditorApp.setStageInsets`), so neither ever covers what the user works on. A first version laid both over the canvas, and the properties panel, which appeared with the selection, covered the elements the user had just made at the top left (the end-to-end tests of selection and text clicked on it). With nothing selected, the column says how to get properties. The custom panels (routes) still lie over the canvas at its right, the save status at its bottom left, the storage layer's notices at its bottom centre and the editor's notices at its top centre; the context menu opens where the canvas was clicked. The status bar has lost its buttons: saving is in the toolbar, and a presentation in a browser is closed with its tab (the warning before an unsaved tab closes stays).

### The page from a folder

`apps/web` builds with a relative base path (`base: "./"`), so the built page, its worker, its fonts and its second page work from any folder, as GitHub Pages serves the project from `/galatsa/`.

## User behaviour (Claude's choices)

These were decided by Claude, not by the users, and can be changed when the users have tried them:

- Where things stand (above), one row of icon buttons with tooltips, no text on the buttons.
- The tool groups' order is the extensions' order: selection, text, shapes, crop.
- The language is a choice in the toolbar, with the languages' own names.
- The properties panel is always there, 16 rem wide (at most 40 % of the window), and has no button to hide it.
- Opening a file asks first only when the presentation has changes not saved to a file.
- The first visit opens an empty presentation, not a start page.
- The status bar's "Close the presentation" button is gone.

## Known limitations

- The frame and presentation commands need `toolbar` set on them to get a button (see above).
- Size, position and rotation are not in the properties panel: no field describes them in 0005, and they are changed with the selection tool's handles. A field bound to the basics' `resize` could be added.
- Saving always asks where to save: the session keeps no file handle (0007, "Storage"), so there is no "save" to the same file yet.
- Every opened file and every first visit makes a new stored presentation, and nothing removes the empty ones or lists the others (0006 section 11, item 4).
- A number is committed per change, not scrubbed with the mouse; how often a colour picker reports a value while it is dragged depends on the browser.
- The toolbar is reached with Tab, button by button; arrow keys do not move within it.
- The toolbar wraps on a narrow window, and the canvas gets smaller; the properties column scrolls. The column takes room from the canvas also when nothing is selected.

## Tests

- `packages/extension-api/src/command.test.ts`: toolbar commands per mode by group, groups in registration order, commands without a group left out; `isActive` for a toggle, a command without `active`, one whose `active` throws and an unknown id.
- `packages/editor/src/ui/toolbar.test.ts`: the tools by group with the current one pressed, and picking one; undo and redo enabled as the history allows, and run from their buttons; a panel's toggle by its toolbar group, pressed while the panel is open and not after it closes; shortcuts written as the keys are marked, in Norwegian and English, on Windows and Linux and on macOS.
- `packages/editor/src/ui/properties.test.ts`: nothing without a selection; the fields per mode and only where they apply to every selected element (fill not for a line, corner rounding not for an ellipse); a mixed state, and one section per type; a change of two elements as one undo step that undo takes back; a colour drag previewed without any document update and committed as one step, and a cancelled one writing nothing.
- `tests/e2e/shell.spec.ts` (Chromium and Firefox): an empty presentation on the first visit; tooltips with shortcuts; a text made with the text tool's button; a rectangle drawn after picking its button; the fill changed in the properties panel as one undo step; an image inserted from a file through the toolbar and the file chooser; a frame around the selection through its button where there is one; a route of two stops from the routes panel, opened from the toolbar; saved as a file (Chromium: through the File System Access API, over files of the origin private file system; Firefox: as a download) and opened again (Chromium: through the API; Firefox: after the question, through the file chooser), with every element, its data and position, the stops, the route and the image's bytes as before. And: the sample scene opens with `?scene=bench`, and the language changes from the toolbar, with the page's `lang`.
