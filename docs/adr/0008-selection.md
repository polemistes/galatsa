# 0008 Selection and transformation

- Status: Accepted
- Date: 2026-11-27
- Code: `packages/extensions/select` (`@galatsa/extension-select`, the built-in extension `galatsa.select`), `packages/editor/src/clipboard.ts`, `packages/editor/src/context-menu.ts` and `ui/ContextMenu.svelte`, the clipboard and context menu in `packages/editor/src/dom.ts`, `isEnabled` and `extensions` on the tool session (`packages/extension-api/src/tool.ts`), `about` on the basics' `rotate`, `tests/e2e/selection.spec.ts`

## Context

The editor foundation ([0007](0007-editor-foundation.md)) runs tools and commands on a document, and the basics extension ([0005](0005-extension-interface.md) section 12.1) has the commands every element has. What was missing is the tool most work is done with: selecting elements, moving, scaling and rotating them with handles, and a way to reach grouping, locking, copying and pasting, duplicating and deleting. Copy and paste went through the browser's events but kept the copy in the editor's memory, so nothing could be pasted into another document or another tab.

## Decision

### The tool is a built-in extension

The selection tool is the extension `galatsa.select` in `packages/extensions/select`, written against the extension interface like any other extension and running the basics' commands. The editor loads it right after the basics, before the program's extensions, so its tool is the first one and therefore the default tool when the program names none, and it keeps the `V` shortcut if a later extension claims it.

It is a package of its own, and not code inside the editor, because 0005 section 5 asks that the selection tool be written against the same interface as every other tool: a separate package cannot reach the editor's internals, so whatever it needs has to be in the interface, where other tools can use it too. The player does not load it. The selection sketch (`examples.select`) stays in the examples as the sketch it was; the development page and the editor's tests load the element sketches without it.

### Two additions to the tool session, and one to the basics

Working out the handles needed two things a tool session did not have (interface version 1.2, additive, 0005 sections 2 and 5):

- `session.isEnabled(command, args)`: whether `run` would accept a command now, the check a menu makes to grey out an entry. A handle is shown only where the command it ends in would be accepted, so the rules stay in one place: the commands. Without it a tool would have to repeat the commands' checks (locks, capabilities, groups, frames) and could disagree with them.
- `session.extensions`: the loaded element types and their capabilities. A scaling must be previewed exactly as the `scale` command will do it, through groups and frames, with placeholders moved rather than resized. `planScale` computes that, and now takes the document and the extensions (`Pick<CommandContext, "doc" | "extensions">`) instead of a whole command context, as does `capabilitiesOf`. Code that passed a command context still compiles.

The tool session also gained four resize cursors (`nwse-resize`, `nesw-resize`, `ns-resize`, `ew-resize`), chosen for the handle's direction on a turned box.

The basics' `rotate` takes an optional `about` with `by`: a point in root space the elements turn about together, so a selection of several elements turns as one, each centre moving around the point, in one transaction. Without it, the command turned each element about its own centre.

### Selecting

- A click selects what the editor's hit test gives: the outermost group the element is in, up to the nearest frame. Locked elements are passed over, so a locked background does not get in the way of what lies on it or of a rubber band started over it.
- Shift-click adds an element or takes it out. A click (no move) on one of several selected elements selects it alone; a drag from it moves them all.
- A drag that starts on empty canvas is a rubber band: it selects what it touches, without locked elements; with Shift, in addition to the selection. Inside the box of the selection (between its elements), a drag moves the selection instead.
- Escape cancels a drag, or else clears the selection.

### Handles

The box of the selection is the element's own box, turned with it, when one element with a size is selected; otherwise (several elements, or a group) the union of their bounds, unturned.

| Handle                | Does                                                                                                                                                                              | Command  | Shown when                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| The selection itself  | Moves; with Shift, horizontally or vertically.                                                                                                                                    | `move`   | `move` is enabled                                                             |
| Corners               | Scale about the opposite corner, proportions kept (the pointer projected on the diagonal), with Alt about the centre. Groups and frames scale with what is inside them.           | `scale`  | `scale` is enabled                                                            |
| Corners with Shift    | Resize one element freely, both sides following the pointer.                                                                                                                      | `resize` | as below                                                                      |
| Sides                 | Resize one element along its own axis, the opposite side staying (Alt: about the centre); on a turned element the corner is computed back from the moved centre.                  | `resize` | one element, not a group, `resize` enabled; box at least 28 px long on screen |
| Above the box (24 px) | Rotates about the box's centre; several elements turn together about the centre of the selection. With Shift, in steps of 15 degrees (one element: its angle, several: the turn). | `rotate` | `rotate` is enabled                                                           |

Every handle is shown only when its command is enabled for the selection (`isEnabled`). That gives the rules of 0005 section 12.1 and the decisions behind them without a second copy: elements of a missing extension can be moved but get no scaling, resizing or rotation handle when alone (scaled with other elements, they move and keep their size); a locked element gets no handle and is not moved; groups and frames are not rotated, so a selection with one has no rotation handle.

Handles, their reach (7 px), the rubber band's outline and the click distance (3 px) are in screen pixels, the same at every zoom. The handles' state is worked out once per selection, document change and mode, not on every frame.

### One drag, one step

Every drag previews its result through a gesture (0005 section 4.7) and ends in one command: nothing is written while dragging, the drag is one undo step, and moving, scaling, resizing and rotating are each one document transaction. A press that moves less than 3 px is a click; a handle pressed and let go without moving changes nothing; where the pointer is let go counts. A handle follows the pointer from where it was taken, not from the point under the pointer, so taking it slightly off its centre does not make it jump. Escape and losing the pointer cancel the drag. The preview of a scaling is `planScale` with the arguments the `scale` command will get, so it shows what the command does.

The editor draws the selected elements' outlines from the renderer's screen rectangles, which follow a preview; the tool draws its handles and, for several elements or a group, a dashed box, and hides them during a drag.

The arrow keys move the selection by one screen pixel, ten with Shift, each press one step.

### The system clipboard

A copy writes the fragment that the basics' `copy` returns into a small envelope, `{ "kind": "galatsa/fragment", "version": 1, "fragment": … }`, as JSON, twice:

- under the program's own type `application/x-galatsa-fragment+json`, which the browser's copy and paste events carry;
- as plain text. The asynchronous clipboard (used by the context menu's paste, below) reads plain text (`readText`) in every browser the program runs in, but not a type of the page's own; and plain text is the form most likely to survive where a type of the page's own is not passed on.

A paste reads the program's type first, then plain text that is an envelope of this version. The fragment is still unchecked; the basics' `paste` reads it with the document's grammar and refuses what does not read (0005 section 12.1). Plain text that is not an envelope, and files, are described in what the paste found (`ClipboardContent`: `text` and `files`) and not pasted yet, and the browser's default goes on: pasting text as a text box and images as image elements belongs to the text and image extensions, which can take them from there.

A paste lands where the fragment was copied from if any of it is in view (on top of the original, in the same document), and otherwise with its centre in the middle of the view.

The editor also keeps the last copy in memory. It is used only by the context menu's paste where the browser refuses to let the page read the clipboard.

### The context menu

Until the editor shell has toolbars, a right click on the canvas opens a menu with the selection's actions: cut, copy, paste; duplicate, delete; group, ungroup; lock, unlock; select all. Entries are the basics' commands, with their labels, offered as the mode offers them (lock and unlock are in advanced mode) and greyed out when the command would be refused. A right click on an element that is not selected selects it first, a locked element too: that is how a locked element is reached to unlock it, since clicks pass over locked elements. On empty canvas the selection stays.

Cut and copy from the menu call `document.execCommand`, which during a click makes the browser send its copy or cut event, so they write the system clipboard the same way as the keys. A page cannot make the browser send a paste event, so paste from the menu reads the asynchronous clipboard (`navigator.clipboard.readText`); where the browser refuses or does not offer it, it pastes the editor's last copy.

The menu is a Svelte component over the canvas, drawn from a small store on the editor (`editor.contextMenu`). It keeps inside the canvas, closes on Escape, a click elsewhere, the wheel or leaving the window, moves between entries with the arrow keys, and gives the keys back to the canvas when it closes.

## Rejected alternatives

- **The tool inside the editor package**, with access to the host and the renderer. Quicker, but the selection tool would then be the one tool that does not go through the interface, and the next tool needing the same would find nothing there.
- **Hidden commands that answer questions** (a command not undoable that returns the handles, or a scaling plan), to avoid changing the interface. Commands are user actions, listed in menus and the command search; using them as queries mixes the two.
- **Free resizing from corners by default, Shift for proportions**, as some drawing programs do. A presentation is mostly pictures, text and groups, whose proportions are meant to stay, and a group can only be scaled with its proportions; one rule for every corner is easier to learn.
- **Turning each element of a selection about its own centre.** Simpler (no change to `rotate`), but the selection then falls apart instead of turning as one.
- **Selecting locked elements with an ordinary click** (and not dragging them). A locked background would then be selected by every click on empty parts of the slide and by every rubber band started over it, which is what locking it was meant to prevent.
- **The fragment in HTML (`text/html`) instead of plain text**, so that plain text could hold readable text. HTML read through the asynchronous clipboard may be cleaned by the browser before the page gets it (not checked in each browser), while plain text arrives as it was written. The cost is that pasting into another program gives the envelope's JSON.
- **A fresh offset for every paste**, so repeated pastes step down and to the right. Duplicate already does that; paste keeps the place, which is what pasting into another document needs.

## Known limitations

- Pasting into another document carries the fragment but not image bytes: images pasted from another document show their stand-in until their bytes come with them.
- Pasting into another program gives the envelope's JSON as text.
- No snapping and no guides while dragging.
- The rubber band selects when it is let go; it does not show what it would select while dragging.
- Each arrow key press is an undo step of its own.
- The context menu shows no shortcuts and has no submenus; there is no long press for touch, and only the first pointer is used (0007).
- The context menu's paste needs the browser's permission to read the clipboard: Chromium can be given it once, and other browsers may ask the user each time (not tested: see Tests); where it is refused, the menu pastes the last copy made in the same editor.
- Handles are placed and hit in root space, as tool pointer events are (0007, precision of `ToolPointerEvent.world`); under a camera anchored deep in a frame they inherit that limit.
- A selection holding a group can be scaled but not rotated, because groups are not rotated (0005 section 12.1).

## Tests

- `packages/extensions/select/src/geometry.test.ts`: points in and out of a turned box, the handle within reach, scaling factors along the diagonal with a minimum, resizing from a side, a corner and the centre, also of a turned box, angles and steps, and the resize cursor for a handle on a turned box.
- `packages/editor/src/selection.test.ts` (Node, the editor with pointer events and keys): click, Shift-click and the click that selects one of several; a rubber band, with Shift, passing over locked elements; Escape clearing the selection; moving several elements, from between them and with Shift, each drag one step and at most two document updates, nothing written during the preview, undone; nudging with the arrows; a locked element not dragged, not even when selected; a group scaled from a corner with the proportions between its members kept; Alt scaling about the centre; side and Shift-corner resizing, also of a turned element; a handle pressed and let go changing nothing; an element of a missing extension moved and not scaled, and moved but not resized when scaled with a shape; rotating one element, with Shift in steps, and several about their centre; Escape cancelling a rotation; no rotation for a group; grouping, ungrouping, duplicating, locking and deleting with the keys, each undone; copying to a clipboard's data and pasting from it into another editor with another document, from plain text alone, refusing foreign text, another envelope version and a damaged fragment; pasting what was copied out of sight in the middle of the view; cutting as one step; the context menu selecting a locked element, offering unlock, unlocking and undoing it, and handing the clipboard entries to the page; the menu's entries per mode, greyed out with nothing selected.
- `packages/extensions/basics/src/commands.test.ts`: `rotate` with `about` turns elements together in one transaction and one step, an element in a frame staying in it.
- `tests/e2e/selection.spec.ts` (Playwright, the development page): click, Shift-click and a rubber band; Ctrl+G and scaling the group from a corner with its proportions kept, one Ctrl+Z taking it back; Ctrl+Shift+G; rotating with the handle; Ctrl+Shift+L, a locked element that is not dragged, a right click and the menu's Unlock, undone and redone; Ctrl+D and Delete, each undone; Ctrl+C, and in Chromium the system clipboard read back as the envelope; Ctrl+V in a second page with an empty document of its own, so that only the system clipboard can carry the copy; copy from the context menu and paste in the second page; in Chromium, paste from the context menu through the asynchronous clipboard. Runs in Chromium and Firefox (`chromium` and `editor-firefox`), and in WebKit (`editor-webkit`) where Playwright's WebKit runs.
- `tests/e2e/webkitgtk/editor_check.py`: in the system's WebKitGTK under Xvfb, with real input, besides the steps of 0007: copy and paste through the system clipboard, scaling from a corner handle and rotating with the handle, each undone, and the context menu opened with a right click and closed with Escape.

What the tests cannot cover headless: pasting from or into another program (the tests copy and paste inside one browser); the permission prompts of Firefox and WebKit for the context menu's paste, which a headless browser does not show (so that path is tested in Chromium only, with the permission granted); and Playwright's WebKit, which needs the libraries of the Ubuntu release it was built for and runs in CI only (WebKitGTK is checked instead).
