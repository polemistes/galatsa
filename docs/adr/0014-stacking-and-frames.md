# 0014 Stacking order and frames in the editor

- Status: proposed
- Date: 2026-11-27
- Code: `packages/extensions/basics` (`frames.ts`: `frame`, `remove-frame`, `rename`, `move-into-frame`, `move-out-of-frame`, `frameAt`; `move` with `target`; the stacking shortcuts in `structure.ts`), `packages/extensions/select` (`frames.ts`: frame outlines and names, drop targets; `frame-tool.ts`; dragging into and out of frames and a band inside a frame in `tool.ts`), `packages/editor` (`rename.ts`, `rename-target.ts` and `ui/RenamePanel.svelte`; the context menu's entries and a right click on a frame's name in `context-menu.ts`; `paste-target.ts`; a dead key in `keymap.ts`), `tests/e2e/frames.spec.ts`

## Context

The document model has frames and z-order from the start ([0001](0001-document-model-and-file-format.md) sections 4 and 5): a frame (`core/frame`) is a named, visible rectangle that holds elements, which follow it when it moves; z-order applies among siblings, so the stacking inside a frame is the frame's own; a change of container keeps an element's place on the canvas with a rebase, and "a drag that ends in another container is a reparent followed by a move, in one command" (0001 section 5.3). The basics extension ([0005](0005-extension-interface.md) section 12.1) had the commands for restacking and for moving into another container. What was missing was the editor's side: keys, menu entries and a tool, making a frame around what is selected, dragging into and out of frames, and naming a frame. [0008](0008-selection.md) left one question here: a paste goes back into the container it was copied from, also when the camera or the selection is in another frame.

## Decision

### No change to core or the extension interface

Everything is built on the basics, the selection extension and the editor. `packages/core` and `packages/extension-api` are unchanged, and the interface version stays at 1.6: the commands are the basics', the outlines and names are an overlay (1.5, [0013](0013-routes-and-stops.md)), the frame tool is a tool, and the rename panel is a custom panel with the editor's Svelte binding (0007).

### Commands (basics)

| Command             | Arguments                              | Does                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `move`              | `{ ids, dx, dy, target? }`             | As before, and with `target` (a frame or group, or null for the canvas) the elements not seen there yet are moved into it first, keeping their place, then all are moved by the offset: a drag into or out of a frame, one step. `dx` and `dy` may then be 0. Refused into a locked or gone container, into one of the moved elements, or into what is inside one.                                         |
| `frame`             | `{ ids }` or `{ rect, parent?, ids? }` | With `ids` alone: a frame around elements seen in the same open container, with a margin of 5 % of their larger side, in the frontmost member's slot (as a group), the members in it in their order. With `rect` (in `parent`'s space): a frame there, with the given elements of `parent` in it (the frame tool). New frames have no fill, no line and no clipping. Selects the frame and returns its id. |
| `remove-frame`      | `{ ids }`                              | Dissolves frames (0001 section 5.5): what was in them stays where it is, on the canvas and in the stacking order. Selects it.                                                                                                                                                                                                                                                                              |
| `rename`            | `{ id, name }`                         | Sets an element's name, at most 200 UTF-16 units and well formed. Refused when the name is the same, and for locked elements.                                                                                                                                                                                                                                                                              |
| `move-out-of-frame` | `{ ids }`                              | Elements seen in the same frame go into the container the frame is in, just in front of the frame, keeping their place. Refused when they are not in a frame (a group is not left this way) or the container is locked.                                                                                                                                                                                    |
| `move-into-frame`   | `{ ids, target? }`                     | Into `target`, or without it into the frame on top under the centre of their bounds (`frameAt`), in front of what is in it, keeping their place. Refused when there is nothing to do.                                                                                                                                                                                                                      |

`frameAt(doc, point, exclude)` is the frame on top at a point in root space: of every open (seen, not locked) frame, found by its type, the frontmost in drawing order whose box holds the point where it can be seen (inside every clipping frame around it), passing over the frames in `exclude` and everything inside them (`openFrames` and `topFrameAt`). Frames inside groups are found, and so is a nested frame where it reaches out of its frame, as the user sees them. The drawing order is the effective tree's: siblings by key and id, a container before what is in it (`drawingPath`). The frame tool, `move-into-frame`, the drag of the selection and the paste use this one rule.

Each is one undo step through the registry, and the random undo tests (`undo.test.ts`, `concurrent.test.ts`, `alone-after-concurrent.test.ts`) now draw them too, `move` with a target included.

**The two-user undo test.** Its rule 1 puts back every position the undo wrote and checks that nothing else moved. A move into another container writes the element's container and its position in one step; the old position read under the restored container is then converted from another space (0001 section 5.3, rule 3), which says nothing about the step. So for an element whose container the step changed as well as its position, the check now puts back its container and rebase with the position. Seed 9 failed before this, with the element back exactly where it was before the step; 24 seeds of 500 steps pass.

### Stacking: keys, menu and mode

The four stacking commands were there (0005 section 12.1). They are now all offered in quick mode (one step forward and back were advanced only), since they are part of what this package delivers; and in the context menu, as their own group.

**Shortcuts.** `Mod+]` one step forward, `Mod+[` one step back, `Mod+Shift+]` to the front, `Mod+Shift+[` to the back, as in many drawing programs; and the same with the arrow keys, `Mod+ArrowUp`, `Mod+ArrowDown`, `Mod+Shift+ArrowUp`, `Mod+Shift+ArrowDown`, which are in the same place on every keyboard layout and need no AltGr. On a Norwegian keyboard [ and ] need AltGr (AltGr+8 and AltGr+9). The keymap of 0007 gives them in two ways:

- by place: Ctrl and the key right of P (Å) is `Mod+[`, and Ctrl and the key right of that (¨, a dead key) is `Mod+]`, with Shift to the back and the front. A dead key used to name nothing; with Mod it is now matched by its place, as on a US keyboard (alone, or with AltGr, it still names nothing: it starts a character);
- by character, on Linux, where Ctrl and AltGr can be told apart: Ctrl+AltGr+8 gives [ and is `Mod+[`.

No shortcut uses Alt with a letter (E10). The browsers: Chromium and Firefox use neither the brackets with Ctrl nor Ctrl with the arrows for anything a page cannot take; the end-to-end test presses Ctrl+[ in both and checks that the page does not go back in its history (from memory: Firefox's own list of shortcuts names Ctrl+[ as Back on some systems; the test shows that the page's handler wins on Linux). The frame command has no shortcut yet: Figma's Ctrl+Alt+G is AltGr+G on Windows, which types a character on some layouts.

### Frames on the canvas

A new frame has no fill and no line, so it would be invisible while editing. The selection extension contributes an overlay (`galatsa.select/frames`) that draws every frame on screen with a thin dashed outline and its name (or "Ramme"/"Frame" when it has none) above its top-left corner, at a fixed size on screen (12 px text in an 18 px strip, cut off at the frame's width, at most 320 px; no name on a frame under 24 px wide). It is editor chrome: never exported and never drawn by the player. The frames are drawn in drawing order, and where a frame is being dragged, at the place of the drag's preview (the offset of the frame's own space, which the scene gives with the preview). The frames are found by their type, once per change of the document, and only they are resolved: 0.3 ms per frame on screen for 50 frames holding 5,000 elements (Node, without drawing; the review measured 3.4 ms for 500 frames and 18 ms for 2,000).

**Taking frames** (selection tool):

- **The name is a handle.** A press on it selects the frame, and a drag moves it with everything in it, as one step. It is taken exactly where it is drawn: the name's text with 4 px on each side, as wide as it was last drawn (estimated before), never wider than the frame on screen nor 320 px, and not at all on a frame under 24 px wide. Where names overlap, the one on top in drawing order is taken. An element over the name wins; a locked frame's name is passed over, as locked elements are. A right click on the name selects the frame (a locked one too), so the context menu acts on it.
- **The background.** A click on a frame's background (where no element inside it is hit) selects the frame and a drag moves it, as with any element (unchanged from 0008). With Shift, a drag there draws a rubber band among what is in the frame (its logical children), added to the selection, so several elements in a frame can be selected without taking the frame; a Shift-click there adds or removes the frame. Between the elements of a selection inside a frame, a drag on the frame's background moves the selection, not the frame.

**Dragging into and out of frames.** An element stays in its container unless it clearly lands elsewhere. What is followed is the centre of the selection's bounds, moved by the drag's offset (with Shift's lock), not the pointer: the pointer may be on a part that reaches out of a frame, on a frame's name above its box, or off the frame while Shift keeps the move level. When the drag is let go (`dropInto`, with the frame on top as `frameAt` finds it, not counting the dragged elements and what is inside them):

1. Where the frame on top under the centre is the frame the selection is in (through groups, which it stays in), it stays.
2. Where the centre has crossed a frame's edge since the drag started (the frame on top under it is another than at the start), it goes into the frame on top there, or out to the canvas.
3. Otherwise (it started with its centre outside its frame's box, over the same frame or canvas as now), it stays until the centre has moved half the selection's larger side, at least 24 px, from where it started; then it goes where rule 2 would put it.

A selection in different frames stays unless its centre crosses a frame's edge, and then all of it goes there. While dragging, the frame it would go into is outlined. It is one command (`move` with a target): one undo step, one place on the canvas. The frames are found once when the drag starts (0.3 ms for 50 frames holding 5,000 elements), not on every move. The review's cases are each a test: a frame in a group (the element stays in the frame, the frame in the group), a nested frame reaching out of its frame, a frame dragged by a name that lies over its parent or over the frame above, Shift's lock, an element taken by a part outside its frame, and a selection in a frame and on the canvas.

**The frame tool** (`galatsa.select/frame`, key F): a drag draws a frame in the frame on top (`frameAt`) at the point where it starts, and what lies wholly inside the rectangle there (not locked) goes into it; a click makes a frame of 480 × 270 px on screen (16:9) with its corner at the point. The new frame is selected and the selection tool comes back.

### Renaming

The editor has a small built-in extension, `editor.frames` (labels in the editor's namespace, like the navigation): the command `rename-frame` (F2, and "Rename frame…" in the context menu; not a step) opens the panel `editor.frames/rename` for the one selected frame. The panel has the name in a text field, focused and selected; Enter or Save runs the basics' `rename` (one undo step) and closes it; Escape or Cancel closes it without a change. The canvas gets the keyboard back either way. The panel is in the editor, not in the selection extension, because a custom panel's component needs the editor's Svelte binding (`PanelProps`), and the editor depends on the selection extension, not the other way round.

### The context menu

Its entries are now: cut, copy, paste, insert a file; duplicate, delete; bring to front, one step forward, one step back, send to back; group, ungroup; frame the selection, remove the frame and keep the contents, move into the frame below, move out of the frame, rename the frame; lock, unlock (advanced mode); select all. Each is greyed out when its command would be refused.

### Where a paste lands

0008 pasted into the container the fragment was copied from while that is there, and if its place was out of view, moved it to the middle of the view, still in that container: an element copied from a frame far away landed in that frame but showed in another (the one being looked at). Now (`paste-target.ts`), the container, in order:

1. A frame selected alone, that is neither one of the copied elements nor a copy an earlier paste of the same fragment made: into it ("paste into the frame I picked"). The editor remembers what the last pastes of a fragment made, so a copied frame pasted twice lands next to the first copy, not in it.
2. Otherwise, what is selected is all seen in one open container that is in view (the canvas, or a frame that meets the view): into it. Where that is the container it was copied from (after a copy the copied elements are still selected), it keeps its place, as before; elsewhere it is put on the selection, centred on it.
3. Otherwise, the container it was copied from (or the canvas), while that is open and the place it would land is in view.
4. Otherwise, the frame being looked at: the frame on top at the centre of the view (`frameAt`'s rule), or the canvas.

It keeps its place on the canvas (or the selection's, 2) when that can be seen in the target (it meets the view, and in a frame the part of the frame in view); otherwise it is centred in that part, or in the frame when a selected frame is out of view altogether. Last, it goes into the frame it shows in: where the frame on top at the centre of where it lands is another than the target (not a copied frame nor a copy of one), it goes into that frame at the same place. So a copy of an element of a frame never lies on the frame without being in it, and a paste never lands in one frame while showing in another.

### Stops

A frame stop stores its frame, not a rectangle (0013), so it follows the frame whatever moves it: a move, a drag, a frame put around it, a move into another frame, and the removal of a frame around it. `frames.test.ts` in the basics checks each of these.

### Resizing a frame

What is in a frame is placed in the frame's space, whose origin is the frame's corner. Resizing a frame from its left or top side moves the corner, so everything in it moved on the canvas by as much (found in review). The basics' `resize` now moves every child of a frame (in the effective tree, gone ones too, so that what an undo of a delete brings back is in place) back by the corner's move, in the same transaction, and the selection tool's preview does the same, so nothing inside moves while the side is dragged.

### User behaviour chosen by Claude

These are choices of how the program behaves, made by Claude for the users to try (none is a user decision):

1. New frames are invisible in the presentation (no fill, no line, no clipping); the editor shows their outline and name. Fill and line can be set when the properties panel comes (F1-16).
2. A frame around a selection has a margin of 5 % of the larger side and takes the frontmost member's slot (as a group does).
3. The name above a frame is a handle that selects and moves it; a click on the background selects it and a drag moves it; Shift and a drag on the background draws a band among its contents.
4. A dragged selection stays in its frame unless its centre clearly lands elsewhere: it crosses a frame's edge, or (having started outside its frame's box) moves half its size; groups are kept. Rule above, "Dragging into and out of frames".
5. The frame tool's click makes a 480 × 270 px frame (16:9 on screen); a drawn frame takes in what lies wholly inside it.
6. Renaming is in a small panel (F2 or the context menu), not in place on the canvas.
7. The paste rule above.
8. All four stacking commands in quick mode, with brackets and arrows as shortcuts; the frame command without a shortcut.

## Known limitations

- A double click on a frame's name does not rename it; renaming is F2 or the menu.
- A frame's name is drawn and taken for frames inside a clipping frame also where the clipping hides the frame.
- A nested frame's name strip lies over its parent's content: a click there on the parent's background takes the nested frame (an element there still wins).
- `frameAt` and the context menu read the document anew each time: `frameAt` about 11 ms for 50 frames holding 5,000 elements, and opening the context menu 70 to 170 ms (one resolution per entry it greys out, 20 entries; measured in review). The frames on screen are found again in every frame drawn, linearly in their number: 18 ms for 2,000 frames on screen. Neither is felt with tens of frames; both can be kept from frame to frame when it matters.
- A frame's outline follows a drag's preview, but not its size during a resize or scaling preview: it shows the new size when the drag ends.
- **Undoing a frame around elements while another user works in it** (found in review, for phase 4, sync): the frame is created by the step, and undoing a creation removes the element with what the user sees in it (0001 section 10). What another user put into the frame meanwhile goes with it, for both users, and only the first user's redo brings it back. Grouping instead creates its group dissolved and undo dissolves it, leaving others' elements in place. Making `frame` behave like grouping (create the frame dissolved in an untracked transaction and restore it) is the likely remedy; it changes the undo of a created frame and is left for the sync work of phase 4.
- On Windows, what a browser reports for Ctrl with a dead key is not checked (AltGr with a dead key, reported as Ctrl and Alt, names no shortcut, by a test of that form); the arrows are the shortcuts that work on every layout. On a German keyboard the key right of Ü gives +, so Ctrl and it is `Mod++` (zoom in), not `Mod+]`; and Ctrl with the dead key ´ is `Mod+=`, also zoom in.
- Fill, line and clipping of a frame cannot be changed yet (the properties panel, F1-16), nor can a frame be resized other than with the selection tool's handles.

## Rejected alternatives

- **A new extension package for frames.** The commands belong with the basics' other structural commands (group, reparent), where the context menu already finds them; the overlay and the tool need what the selection tool knows (the names are its handles). A package of its own would add a dependency and nothing else.
- **Menu entries contributed by extensions** (a flag on commands, or a menu contribution). It would change the interface for what a few entries in the editor's own menu do; the editor shell's menus are later work.
- **Renaming in place**, a text field over the frame's name. It needs a way from the tool to the editor's interface (the double click) or editor code that knows the names' geometry; the panel uses what exists.
- **A drag on the background of a frame that is not selected draws a band** among its contents, the frame being moved by its name or once selected (as some drawing programs do for top-level frames). Tried first: a frame then no longer moved when dragged like any other element, which the routes test (0013) and users of the selection tool (0008) rely on. Shift, which already means "add to the selection", draws the band instead.
- **Selecting frames only by their name.** An empty frame, or one far zoomed in, would be hard to take; a click selecting it is what a user expects of a visible rectangle.
- **Dropping by the pointer** (the first version): the pointer is what the user aims with, but it is often on a part of the selection that reaches out of its frame, on a frame's name above its box, or off the frame while Shift keeps the move level, and an element was thrown out of its frame by a small drag in each of these cases (review). The selection's centre, and staying unless it clearly lands elsewhere, is what the user sees.
- **A drop target that includes groups.** Groups have no box of their own to aim at; elements are put into a group by grouping. Frames inside groups are drop targets.
- **Walking the frames from the root, inside each frame's box** (the first `frameAt`): it did not find a nested frame where it reaches out of its frame, nor frames inside groups.

## Tests

- `packages/extensions/basics/src/frames.test.ts`: a frame around elements with its margin, in the frontmost member's slot, the members in order and unmoved, selected; a frame at a rectangle with elements of its parent; refusals (different containers, locked, bad rectangles, a locked parent); removing a frame keeping order and place; renaming, with an emoji and to nothing, and its refusals; moving out of a frame in front of it, from a nested frame, and the refusals; moving into the frame under the elements and into a given one; `frameAt` with front and back frames, exclusions, a locked and a deleted frame; `move` with a target into and out of frames, a pure change of container and a frame moved into a frame with its contents, and the refusals; a picture sent to the back of a frame with text on top and the frame moved without anything shifting; stepping inside a frame; the shortcuts in quick mode; a frame stop following its frame when moved, framed, moved with an outer frame and when the outer frame is removed. Every command checked to be one step that undo takes back and redo brings back.
- `packages/extensions/basics/src/testing.ts`: the random scenarios draw the new commands and `move` with a target.
- `packages/editor/src/frames.test.ts` (Node, pointer events and keys): dropping into a frame and out again, each one step; staying in the frame while the pointer stays in it; no drop into a locked frame; a frame taken and dragged by its name; a click on the background selecting the frame, a band among its contents with Shift, a Shift-click adding and removing the frame, a drag between selected elements moving them and not the frame, a drag on the background moving the frame; the frames on screen for their names, nested ones too; the frame tool drawing a frame around what is inside its rectangle (one step, selected, the selection tool back) and a click making a 480 × 270 frame inside the frame under it; the stacking keys inside a frame (Ctrl+Å, Ctrl and the dead key, Ctrl+Shift+ArrowDown, Ctrl+Shift+] as a US keyboard sends it), each one step, none at the front; the context menu framing, restacking, moving out and in and removing a frame, each one step; the rename panel opened from the menu and with F2; a right click on a frame's name selecting it, a locked one too, an element over the name winning; pasting into a selected frame, into the container of the selection (centred in the frame), into the frame in view when the source is out of view, and back next to the copied element.
- `packages/editor/src/keymap.test.ts`: a dead key alone, with Shift and with AltGr names nothing; the stacking shortcuts on a Norwegian keyboard by place (Å, the dead key, with Shift), by AltGr on Linux, with the arrows, and with Cmd on macOS.
- `packages/editor/src/clipboard.test.ts` and `selection.test.ts`: updated for the paste rule (what was copied out of sight in a frame now lands on the canvas in view) and the menu's entries.
- `tests/e2e/frames.spec.ts` (Playwright, the development page; Chromium and Firefox, and WebKit where Playwright's WebKit runs): a text and a picture; a frame drawn around them with the frame tool, taken back by Ctrl+Z and brought back; the picture sent to the back with Ctrl+Shift+[ so the text is on top, undone and redone; the frame dragged by its name with the picture and the text moving by exactly as much and keeping their order, undone; the text dragged out to the canvas, undone, and dragged out and back in; Ctrl+[ and Ctrl+] restacking without the page going back in its history; Ctrl and Å and Ctrl and the dead key as a Norwegian keyboard reports them; Ctrl+ArrowDown and Ctrl+ArrowUp; the frame renamed from the context menu's "Rename frame…" with the panel's field and Enter, undone; no errors in the console.
- `tests/e2e/webkitgtk/frames_check.py`: in the system's WebKitGTK under Xvfb, with real input: the frame tool around a picture and a text, one step; Ctrl+Shift+] and Ctrl+Shift+[ restacking in the frame, each one step; the frame dragged by its name with everything in it moving by as much, and Ctrl+Z; the text dragged out to the canvas.
