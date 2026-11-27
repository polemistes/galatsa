# 0013 Routes and stops in the editor

- Status: proposed
- Date: 2026-11-27
- Code: `packages/extensions/routes` (`@galatsa/extension-routes`, and `@galatsa/extension-routes/view` for the viewing part; extension `galatsa.routes`); overlays (`OverlayDefinition`, `EditContributions.overlays`, `EditorHost.overlays`, `EditorServices.overlays`) and notices (`EditorServices.notices`) in `packages/extension-api`; drawing overlays, the two services, `focusCanvas` and `PanelProps.i18n` and `PanelProps.focusCanvas` in `packages/editor`; `stopsAndRoutesOf`, `setRouteEntryStop`, `addStop` with `ext`, and rectangle stops in fragments in `packages/core`; `readFragment` in `packages/extensions/basics`; `tests/e2e/routes.spec.ts`; `scripts/lib/viewer-bundle.test.ts`

## Context

The document model has had stops and routes from the start ([0001](0001-document-model-and-file-format.md) section 6): a stop is a region (a frame, or a rectangle in a container's space) with a name, notes, a transition and show/hide changes; a route is a set of entries ordered by keys, each pointing at a stop; stops are shared when more than one route points at them; removing a stop skips its entries everywhere until it is restored. The core operations exist (`addStop`, `setStopView`, `renameStop`, `stopNotes`, `setVisibility`, `removeStop`, `addRoute`, `insertRouteEntry`, `moveRouteEntry`, `removeRouteEntry` and the rest). What was missing is the editor's side: making stops from the view or from a frame, several routes, sharing stops, what each stop shows and hides, the route as a line on the canvas, and notes. The strip of thumbnails belongs to the editor shell; until then there must be a simple way to see, choose, order and jump to the stops of a route. Presenting is the player's (presentation mode).

0001 section 13 item 22 left one question to the editor: whether removing a stop should warn when routes still visit it. The users decided (E9): **deleting a stop that routes still use gives a warning ("used in N routes") and lets the user choose; if the user deletes it anyway, the stop disappears from all the routes.** The warning is a dialog of the program, in both languages, not the browser's `confirm()`, and undo brings everything back.

## Decision

### A built-in extension

Routes and stops are a built-in extension, `galatsa.routes` (`packages/extensions/routes`), written against the same interface as the other extensions ([0005](0005-extension-interface.md)): commands, a custom panel and an overlay. Its viewing part carries only its messages: a viewer has nothing of it to draw, since playing routes is the player's. It has an entry of its own, `@galatsa/extension-routes/view`, which imports no panel, no editor and no commands; the viewer bundle test loads it and checks that. The panel needs `@galatsa/editor` only for types (`PanelProps`); its translations follow the language through a small helper of its own.

### Commands

Every command that changes the document is one undo step (0005 section 4.2), named by its `undoLabel`; commands that change only the camera or the editor are `undoable: false`. Arguments are plain JSON and are checked in `enabled` as well as in `execute`, so a menu or a shortcut can run them without arguments where that makes sense.

| Command                 | Arguments                  | What it does                                                                                                                                                  |
| ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toggle-panel`          | none                       | Opens or closes the panel (`Shift+R`). Not a step.                                                                                                            |
| `add-route`             | `{ name? }`                | A new route, last in the list; it becomes the route shown.                                                                                                    |
| `rename-route`          | `{ route, name }`          | Renames a route.                                                                                                                                              |
| `delete-route`          | `{ route }`                | Removes a route (its stops stay).                                                                                                                             |
| `add-stop-from-view`    | `{ route?, after? }`       | A stop of what the camera shows now, visited after `after` (default: after the chosen step, or last). Without `route` the route shown; a new one if none yet. |
| `add-stops-from-frames` | `{ ids?, route?, after? }` | One frame stop per frame among `ids` (default: the selection), in that order. Disabled when none is a frame.                                                  |
| `add-visit`             | `{ stop, route?, after? }` | Adds a visit to a stop that exists: the stop is then shared by the routes that visit it.                                                                      |
| `move-visit`            | `{ route, entry, index }`  | Moves a visit to step `index` of the route as played (steps of removed stops do not count). Moving to where it is makes no step.                              |
| `remove-visit`          | `{ route, entry }`         | Takes a visit out of a route. The stop stays (it can be added again).                                                                                         |
| `delete-stop`           | `{ stop }`                 | Removes the stop: it is skipped in every route that visits it until an undo brings it back. The command does not warn; the panel does (below).                |
| `rename-stop`           | `{ stop, name }`           | Renames a stop, in every route that visits it.                                                                                                                |
| `set-stop-notes`        | `{ stop, text }`           | Sets the notes as plain text (below).                                                                                                                         |
| `update-stop-view`      | `{ stop }`                 | Points the stop at what the camera shows now (a rectangle; a frame stop becomes a rectangle stop).                                                            |
| `copy-stop-for-route`   | `{ route, entry }`         | Gives one visit a stop of its own: a copy (view, name, notes, show/hide changes, transition, ext) takes the visit's place (0001 section 6.3).                 |
| `set-visibility`        | `{ stop, ids?, action }`   | Shows (`"show"`) or hides (`"hide"`) the elements (default: the selection) on arrival at the stop, or takes the change away (`null`).                         |
| `go-to-stop`            | `{ stop, animate? }`       | Moves the camera to show the stop, along its transition (below). Not a step.                                                                                  |

Some details:

- **A stop of the view** is the rectangle the camera shows, in the camera's own space, carried up through the containers to the innermost one whose box holds all of it (0001 section 6.2: the editor should use the innermost frame that contains the whole rectangle). The camera is anchored in the innermost frame around the centre of the view ([0009](0009-camera.md)), so every frame that holds the whole view is that frame or one above it. Each step up adds the offset between neighbouring spaces, so the rectangle stays exact wherever the camera is anchored.
- **A frame stop** follows its frame: it stores the frame, not a rectangle (0001 section 6.2). Its padding is 0, so the frame fills the screen (brukeratferd, Claude's choice).
- **Order.** New visits come right after the chosen step, so a stop can be added in the middle of a route, otherwise last.
- **Notes** are a shared text (`Y.Text`). The panel edits them as plain text; the command changes only the part that differs (the common beginning and end are kept), so formatting elsewhere and a concurrent edit elsewhere in the notes survive. The common beginning and end are measured in UTF-16 code units, as a `Y.Text` counts, and never end inside a surrogate pair (an emoji outside the Basic Multilingual Plane): Yjs would store half a pair as U+FFFD, and undo could not mend it (`textChange`). Text typed right after formatted text takes its formatting, as Yjs inserts do and as in a word processor. Notes that hold embedded objects, which plain text cannot show, are replaced whole.
- **A stop of its own** (`copy-stop-for-route`) points the visit at the copy in place (`setRouteEntryStop`, new in core): the entry keeps its id, its place and its `ext`. An entry is one JSON value under one key (0001 section 2), so when two users give the same visit a stop of their own at the same time, or one does while another moves the visit, one of the two writes wins whole and the route still has the visit once. (Removing the entry and inserting a new one, as first built, doubled it: a concurrent write beats a delete of the same key, and the new entry came on top.) What the losing write did is lost: the other user's copy is left as a stop without a route (it is listed under "Stopp som finnes"), or the move does not happen. Accepted: nothing is doubled, and nothing the users typed is lost.
- **Deleting a stop** removes it (`removeStop`) rather than deleting its entries: the model already skips the entries of a removed stop everywhere (0001 section 6.3), a concurrent new visit then keeps the stop (0001 section 6.5), and undo is the undo of a mark.

### The warning before deleting a stop

When the user deletes the chosen stop in the panel and live routes still visit it, the panel shows a dialog of its own (`role="alertdialog"`, over the whole window): "Slette stoppet?" with "Stoppet brukes i N ruter. Slettes det, forsvinner det fra alle rutene." (the English text likewise), and the buttons Avbryt (focused) and Slett likevel. The dialog is modal for the keyboard: Tab and Shift+Tab go round its buttons, Escape closes it wherever the focus is, a press on its backdrop keeps the focus in it, and no key reaches the canvas or the panel behind it. The number follows changes made while it is open (another user's), and the dialog closes if the stop is deleted meanwhile. When it closes, the canvas gets the keyboard focus, so Ctrl+Z undoes the deletion at once, also when a text field of the panel had the focus before. Slett likevel runs `delete-stop`: one undo step, and the stop disappears from every route; Ctrl+Z brings it back to all of them. A stop no route uses is deleted without asking. N counts routes, not visits (a route that visits the stop twice counts once). A stop deleted from the panel is always one the route shown visits, so there the dialog always comes; that is the users' rule as written.

### What the editor shows

The editor remembers, per document, the route shown and the chosen step (`state.ts`). This is not document content: it is not saved, not shared with other users and not undone. When the route shown is gone (deleted, or undone), the first route is shown; a chosen step that is gone is no longer chosen.

**The panel** (`RoutesPanel.svelte`) is a custom panel (0005 section 8) on the right side, opened and closed with `Shift+R` (a plain letter picks a tool, and Alt with a letter opens the browser's menus in Firefox, depending on its language: E10, Claude's choice). It shows:

- the route shown, with a list to choose another, its name, and "Ny rute" and "Slett ruten";
- the steps of the route in order, numbered, each named by the stop's name, else the name of its frame, else "Stopp N"; a click chooses the step and jumps there; ↑ and ↓ move it;
- "Stopp fra utsnittet" and "Stopp fra valgte rammer", and "Stopp som finnes" with "Legg til i ruten" (a shared stop);
- for the chosen step: the stop's name, how many routes use it, "Gå til stoppet", "Bruk utsnittet nå", "Eget stopp for denne ruten" (when the stop is visited more than once), what it shows and hides (buttons for the selection, and the list of changes with a button to take each away), the notes, "Fjern fra ruten" and "Slett stoppet".

**The keyboard.** After every action with a button or a list of the panel (not typing in a text field), the canvas gets the keyboard focus back (`PanelProps.focusCanvas`), so Ctrl+Z and the canvas's other keys work at once, without a click on the canvas. A press on a button does not move the focus first, unless a text field has it, which then lets it go so its text is saved. A keyboard user who moves through the panel with Tab is taken back to the canvas after each action too; that keeps one rule for all.

**Names and notes** are saved when the user leaves the field or presses Enter in a one-line field, as one undo step (`DraftField.svelte`); typing is not a step per key. While the user has changed a field and not saved it, another user's change of the same name or notes does not overwrite what they typed; when they save, theirs is written (the last write wins). If the field goes away before it is saved (another user deleted the stop, an undo took it away), what was typed is saved then. A name or notes saved after the stop or route was deleted are written into the removed record, which an undo of the delete brings back with them; the deletion stands, since the user's replica knew of it when the text was saved (0001 section 5.5). The two commands therefore take a removed stop or route; the panel offers nothing else for one. Saving each key at once was rejected: it would make one undo step per key.

**Failures.** A command the panel runs that cannot run or fails is told to the user in the editor's notice (`services.notices`, "Kunne ikke gjøre dette nå: …"), not only in the console. The panel reads the stops and routes again on every change of the document (`stopsAndRoutesOf`, below) and of the choice.

**The route on the canvas** is an overlay (below) drawn while the panel is open: the outline of what each step shows (dashed; the chosen one solid and in another colour), a line through their centres in playing order, and a numbered mark at each centre, at a fixed size on screen. A frame stop's outline follows its frame when the move is committed (not during the drag's preview).

### Jumps

`go-to-stop` fits the stop's region to the screen, keeping its proportions and centring it, with no margin (0001 section 6.2), within the zoom range. It moves the camera along the stop's transition: the built-in transitions of `@galatsa/extension-transitions` (fly, fade, cut; a stop that names none, or a transition this extension does not know, flies), planned from the view now to the goal in the space of their lowest common ancestor so a jump deep in nested frames stays exact, and wrapped in `guardComfort` with the comfort settings from the defaults and the system's "reduce motion" setting. The editor has no cross-fade, so a fade shows the start until half way and then the goal; with reduced motion the guard makes every transition such a fade, so the camera never shows other views. The jump runs on animation frames after the command has returned (it changes only the camera) and stops as soon as anything else moves the camera, so the user can always take over; a new jump stops the last. In the end the camera is set to the goal exactly.

This is for finding one's way while editing. Presenting (fullscreen, next and previous, free roaming, `breakOff`) is the player's.

### Changes outside the extension

Each is the smallest change that made a requirement possible.

- **`@galatsa/extension-api`: overlays and notices.** The route must be drawn on the canvas while no tool is busy, and only tools could draw over the canvas. An editing part may now contribute `overlays`: `OverlayDefinition` has a name, a `quick` flag, `visible(ctx)` and `draw(ctx, context)`, which draws in root space through the same drawing context as a tool's preview. `EditorHost.overlays(mode)` lists them; names are checked like other contributions and they are taken back on unload. `EditorServices.overlays.invalidate()` asks for a new frame when something an overlay shows changes outside the document (the chosen route); `createTestServices` counts the requests. `EditorServices.notices.show(label, values)` shows a message to the user in the editor's notice, so that an extension can say that a command failed instead of passing over it in silence (the editor had no way for extensions to reach its notice); `createTestServices` records them. These are additive and raised the interface's minor version to 1.5.
- **`@galatsa/editor`.** Draws the overlays of the mode in every frame, above the document and below the selection outline and the tool's preview, through a projection of root space (0007); an overlay that throws is reported and left out of that frame. Draws again on every document update (stops and routes are not reported by the live resolver, which follows elements), and when the mode or the open panels change. Implements `services.overlays`. Implements `services.notices` with its own notice (now with message values). **`PanelProps` gains `i18n`**: a custom panel had no way to the program's translations, and no text may be hard-coded; the editor passes its `I18n`. **`PanelProps` gains `focusCanvas()`**, backed by `Editor.focusCanvas`, which the page that mounts the canvas sets up (`mountEditor`): a panel could not give the canvas the keyboard back, so undo did not work after an action in it. It is part of the editor's Svelte binding, not of the extension interface: focus belongs to the page.
- **`@galatsa/core`.** `setRouteEntryStop` points a visit at another stop in place (above), and `addStop` takes the stop's `ext`, so a copy of a stop keeps other extensions' slots. `stopsAndRoutesOf(doc)` reads the stops and routes exactly as `toSnapshot` does (the same grammar), without the elements, so the panel and the overlay can follow every change of a document with thousands of elements. And the known problem from [0008](0008-selection.md): a rectangle stop of a fragment whose `space` is not a frame or group of the fragment (`pos.space` of the stop's view pointed out of the fragment) kept that id when pasted, so it named an unrelated element of the document it was pasted into, or a missing one. `pasteFragment` now reads such a rectangle in the roots' space, as copy writes it (null), and `copyFragment` writes a rectangle whose space is not a container (it is read in root space, 0001 section 6.2) in the roots' space too.
- **`@galatsa/extension-basics`.** `readFragment` refuses a fragment whose rectangle stops or fallback views name a space that is not a frame or group of the fragment, as it already refuses such element positions (0008).
- **`apps/web`** loads the extension (one import, one entry in the list).

### Behaviour for the users that Claude chose

To be put to the users ("brukeratferd, Claudes valg"):

1. A frame stop shows the frame with no margin.
2. The panel opens with `Shift+R`; it is closed when the program starts. The route line is shown only while the panel is open.
3. A new stop comes right after the chosen step, otherwise last; a stop made when there is no route makes the first route.
4. A stop is named by its own name, else its frame's name, else "Stopp N" by its place in the route shown.
5. "Fjern fra ruten" takes the visit out without asking (the stop stays and can be added again); "Slett ruten" deletes the route without asking. Both are undone with one Ctrl+Z.
6. The warning counts routes, not visits, and comes every time a used stop is deleted from the panel.
7. Clicking a step jumps the camera there along the stop's transition (flight by default).
8. Text typed right after bold text in the notes is bold.
9. After an action with a button or a list in the panel, the keyboard goes back to the canvas, also for a keyboard user.
10. A name or notes typed while another user changes the same field win when saved; typed while another user deletes the stop, they are saved into the deleted stop (an undo of the delete brings them back) and the stop stays deleted.

## Known limitations

- The route line and the panel follow a frame stop when a drag of the frame is committed, not during the drag's preview.
- The overlay draws in root space: under deep zoom far from the root it inherits the precision limit of tool overlays (0007).
- A stop visited twice in a route has two marks at the same place.
- The panel edits notes as plain text; formatting can be kept but not made, and embedded objects in notes are replaced when the text is changed.
- Jumps know only the built-in transitions; the comfort settings are the defaults with the system's setting, since there is no settings view yet.
- No choice of transition per stop in the panel yet.
- The panel has no tests of its own in a browser beyond the end-to-end test; the notice after a failed command is not tested in a browser.
- When two users give the same visit a stop of their own at once, one copy is left as a stop without a route.
- "Stopp N" numbers a stop by its place in the route shown in the list of steps, and by its first place in any route in the list of existing stops; stops that no route uses are all "Stopp uten rute".
- The panel and the route line read all stops (with their notes) again on every change and in every frame while the panel is open, and each greyed-out button asks its command; slow with very many stops, not measured.
- The end-to-end test checks undo for some of the panel's actions (a stop from a frame, a rename, deleting a stop), the unit tests for all.

## Tests

- `packages/extensions/routes/src/routes.test.ts` (Node, the real editor over a document, drawing nothing): an emoji swapped in the notes, and undone, without U+FFFD, also at either end and doubled; a stop of its own for one visit given by two users at once, and by one while the other moves the visit, over two synchronised documents, without doubling the visit; the copy keeping `ext`; no jump to a deleted stop; no step for a move past the end; a name and notes saved into a deleted stop; Shift+R opening and closing the panel; a stop of the view makes a route, as one step whose undo takes both away; the view anchored in the innermost frame that holds it, in an outer frame when it does not fit the inner one, and at the root; a frame stop follows its frame and the camera jumps to the moved frame; stops of the selected frames only, in order, after a given step; a shared stop renamed, re-pointed and given notes through one route seen in both, and a separate copy for one route that no longer changes the other; routes renamed, visits moved and removed, a move to the same place making no step, a route deleted; a stop used by two routes (once twice) deleted from both and brought back to both by one undo; show and hide on arrival with the visibility the model computes; notes changed only where they differ, keeping formatting; the route on the canvas (rectangles, line, marks), drawn only while the panel is open, following a moved frame; jumps along a flight ending exactly at the goal, only start and goal with reduced motion, and stopping when the camera is moved by something else. Each command that changes the document is checked to make exactly one undo step that undo takes back whole and redo brings back.
- `packages/core/src/ydoc/stops.test.ts`: `setRouteEntryStop` concurrent with another re-pointing and a move, over two replicas, keeping one entry with its `ext`, and `addStop` keeping `ext`; `stopsAndRoutesOf` equals what `toSnapshot` reads, with removed stops and a record the grammar leaves out; a rectangle stop pasted in the space of a pasted frame keeps it, renamed; one in no space, an outside space, a missing element or a shape lands in the paste's target at the same place; a copy of a stop in a shape's space is written in the roots' space.
- `packages/extensions/basics/src/commands.test.ts`: fragments with rectangle stops or fallback views in an outside frame, a shape or a missing element refused; null and a frame of the fragment accepted.
- `packages/extension-api/src/host.test.ts`: overlays offered per mode, names checked, taken back on unload.
- `packages/editor/src/extension-overlays.test.ts`: overlays drawn in root space through the camera, left out while not visible and when not offered in the mode, drawn again on a document change, a panel opening or closing and a request, and a throwing overlay not breaking the frame; an extension's notice with values, and `focusCanvas`.
- `scripts/lib/viewer-bundle.test.ts`: the routes extension's viewing part in the viewer bundle, without its panel or Svelte.
- `tests/e2e/routes.spec.ts` (Playwright, the development page; Chromium and Firefox, and WebKit where Playwright's WebKit runs): `Shift+R` opens the panel; a stop from the view and one from a selected frame, each one undo step, the second taken back with Ctrl+Z and brought back; the route's mark drawn on the canvas; the frame dragged with the mouse and the camera jumping to it when its step is clicked; a second route sharing the stop and a rename reaching both; choosing a route in the list and then Ctrl+Z and Ctrl+Shift+Z with no click on the canvas; deleting it warning in the program's dialog that two routes use it, Tab and Shift+Tab staying in the dialog, Escape after a click on its backdrop and Cancel keeping it; notes with an emoji typed and, with the notes field focused, Slett likevel removing it from both as one step after the notes' step, and Ctrl+Z, with no click on the canvas, bringing it back to both with the notes; a name being typed kept against another user's rename and saved over it; notes being typed saved when the stop is deleted by someone else; `Shift+R` closing the panel; no errors in the console.

## Rejected alternatives

- **The route line drawn by the panel**, on a canvas or SVG of its own over the editor's: it would have to repeat the camera's projection and the device pixel ratio, and would be a second drawing surface (rejected for the same reasons in 0007).
- **The route line as a tool** that draws its overlay: it would be drawn only while that tool is the current one, and the selection tool, which the user needs to move frames, would hide it.
- **A subscription in the overlay definition** (`subscribe(changed)`) instead of `services.overlays.invalidate()`: the editor would have to start and stop subscriptions per editor and per load; the panel, which changes the choice, already has the services.
- **Deleting a stop's entries together with the stop**: the model already skips the entries of a removed stop, and deleting them would make a concurrent new visit to the stop lose against the delete of its entries.
- **The warning in the command** (a `confirmed` argument): the command would then need to know about dialogs, and a shortcut or another extension could not delete a stop it means to delete. The users' rule is about what the user sees.
- **The browser's `confirm()`**: not translated and not styled, and the users ruled it out.

## New dependencies

None from outside the workspace. The new package declares `svelte` 5.57.3 and `svelte-check` 4.7.8 (both MIT, already used by the editor, [0007](0007-editor-foundation.md)).
