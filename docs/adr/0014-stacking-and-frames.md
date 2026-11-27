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
| `move-into-frame`   | `{ ids, target? }`                     | Into `target`, or without it into the innermost open frame under the centre of their bounds (`frameAt`), in front of what is in it, keeping their place. Refused when there is nothing to do.                                                                                                                                                                                                              |

`frameAt(r, point, exclude)` is the innermost open (seen, not locked) frame whose box holds a point in root space: from the root down, into the frontmost frame that holds it at each level, passing over the frames in `exclude` and everything inside them. Dropping, the frame tool and `move-into-frame` use this one rule.

Each is one undo step through the registry, and the random undo tests (`undo.test.ts`, `concurrent.test.ts`, `alone-after-concurrent.test.ts`) now draw them too, `move` with a target included.

**The two-user undo test.** Its rule 1 puts back every position the undo wrote and checks that nothing else moved. A move into another container writes the element's container and its position in one step; the old position read under the restored container is then converted from another space (0001 section 5.3, rule 3), which says nothing about the step. So for an element whose container the step changed as well as its position, the check now puts back its container and rebase with the position. Seed 9 failed before this, with the element back exactly where it was before the step; 24 seeds of 500 steps pass.

### Stacking: keys, menu and mode

The four stacking commands were there (0005 section 12.1). They are now all offered in quick mode (one step forward and back were advanced only), since they are part of what this package delivers; and in the context menu, as their own group.

**Shortcuts.** `Mod+]` one step forward, `Mod+[` one step back, `Mod+Shift+]` to the front, `Mod+Shift+[` to the back, as in many drawing programs; and the same with the arrow keys, `Mod+ArrowUp`, `Mod+ArrowDown`, `Mod+Shift+ArrowUp`, `Mod+Shift+ArrowDown`, which are in the same place on every keyboard layout and need no AltGr. On a Norwegian keyboard [ and ] need AltGr (AltGr+8 and AltGr+9). The keymap of 0007 gives them in two ways:

- by place: Ctrl and the key right of P (Å) is `Mod+[`, and Ctrl and the key right of that (¨, a dead key) is `Mod+]`, with Shift to the back and the front. A dead key used to name nothing; with Mod it is now matched by its place, as on a US keyboard (alone, or with AltGr, it still names nothing: it starts a character);
- by character, on Linux, where Ctrl and AltGr can be told apart: Ctrl+AltGr+8 gives [ and is `Mod+[`.

No shortcut uses Alt with a letter (E10). The browsers: Chromium and Firefox use neither the brackets with Ctrl nor Ctrl with the arrows for anything a page cannot take; the end-to-end test presses Ctrl+[ in both and checks that the page does not go back in its history (from memory: Firefox's own list of shortcuts names Ctrl+[ as Back on some systems; the test shows that the page's handler wins on Linux). The frame command has no shortcut yet: Figma's Ctrl+Alt+G is AltGr+G on Windows, which types a character on some layouts.

### Frames on the canvas

A new frame has no fill and no line, so it would be invisible while editing. The selection extension contributes an overlay (`galatsa.select/frames`) that draws every frame on screen with a thin dashed outline and its name (or "Ramme"/"Frame" when it has none) above its top-left corner, at a fixed size on screen (12 px text in an 18 px strip, cut off at the frame's width, at most 320 px; no name on a frame under 24 px wide). It is editor chrome: never exported and never drawn by the player. The frames are found by their type, once per change of the document, and only they are resolved: 0.3 ms per frame on screen for 50 frames holding 5,000 elements (Node, without drawing).

**Taking frames** (selection tool):

- **The name is a handle.** A press on it selects the frame, and a drag moves it with everything in it, as one step. The strip is at least 48 px wide on screen however small the frame is. An element over the name wins; a locked frame's name is passed over, as locked elements are. A right click on the name selects the frame (a locked one too), so the context menu acts on it.
- **The background.** A click on a frame's background (where no element inside it is hit) selects the frame and a drag moves it, as with any element (unchanged from 0008). With Shift, a drag there draws a rubber band among what is in the frame (its logical children), added to the selection, so several elements in a frame can be selected without taking the frame; a Shift-click there adds or removes the frame. Between the elements of a selection inside a frame, a drag on the frame's background moves the selection, not the frame.

**Dragging into and out of frames.** When a drag of the selection is let go, the selection goes into the innermost open frame under the pointer (`frameAt`'s rule, not counting the dragged elements and what is inside them), or out to the canvas when no frame is under it; where all of it is seen there already, it stays. While dragging, the frame it would go into is outlined. It is one command (`move` with a target): one undo step, one place on the canvas. The frames are found once when the drag starts (0.3 ms for 50 frames holding 5,000 elements), not on every move.

**The frame tool** (`galatsa.select/frame`, key F): a drag draws a frame in the innermost open frame under the point where it starts, and what lies wholly inside the rectangle there (not locked) goes into it; a click makes a frame of 480 × 270 px on screen (16:9) with its corner at the point. The new frame is selected and the selection tool comes back.

### Renaming

The editor has a small built-in extension, `editor.frames` (labels in the editor's namespace, like the navigation): the command `rename-frame` (F2, and "Rename frame…" in the context menu; not a step) opens the panel `editor.frames/rename` for the one selected frame. The panel has the name in a text field, focused and selected; Enter or Save runs the basics' `rename` (one undo step) and closes it; Escape or Cancel closes it without a change. The canvas gets the keyboard back either way. The panel is in the editor, not in the selection extension, because a custom panel's component needs the editor's Svelte binding (`PanelProps`), and the editor depends on the selection extension, not the other way round.

### The context menu

Its entries are now: cut, copy, paste, insert a file; duplicate, delete; bring to front, one step forward, one step back, send to back; group, ungroup; frame the selection, remove the frame and keep the contents, move into the frame below, move out of the frame, rename the frame; lock, unlock (advanced mode); select all. Each is greyed out when its command would be refused.

### Where a paste lands

0008 pasted into the container the fragment was copied from while that is there, and if its place was out of view, moved it to the middle of the view, still in that container: an element copied from a frame far away landed in that frame but showed in another (the one being looked at). Now (`paste-target.ts`), the container, in order:

1. A frame selected alone, that is not one of the copied elements: into it ("paste into the frame I picked").
2. Otherwise, what is selected is all seen in one open container that is in view (the canvas, or a frame that meets the view): into it, next to what is selected. After a copy the copied elements are still selected, so a paste lands next to them as before.
3. Otherwise, the container it was copied from (or the canvas), while that is open and the place it would land is in view.
4. Otherwise, the frame being looked at: the innermost open frame around the centre of the view, or the canvas.

It keeps its place on the canvas when that place can be seen in the target (it meets the view, and in a frame the part of the frame in view); otherwise it is centred in that part, or in the frame when a selected frame is out of view altogether. So a paste never lands in one frame while showing in another, and lands out of sight only in a selected frame that is out of view.

### Stops

A frame stop stores its frame, not a rectangle (0013), so it follows the frame whatever moves it: a move, a drag, a frame put around it, a move into another frame, and the removal of a frame around it. `frames.test.ts` in the basics checks each of these.

### User behaviour chosen by Claude

These are choices of how the program behaves, made by Claude for the users to try (none is a user decision):

1. New frames are invisible in the presentation (no fill, no line, no clipping); the editor shows their outline and name. Fill and line can be set when the properties panel comes (F1-16).
2. A frame around a selection has a margin of 5 % of the larger side and takes the frontmost member's slot (as a group does).
3. The name above a frame is a handle that selects and moves it; a click on the background selects it and a drag moves it; Shift and a drag on the background draws a band among its contents.
4. A drop goes into the frame under the pointer (not under the dragged elements' centre), and out to the canvas when no frame is there.
5. The frame tool's click makes a 480 × 270 px frame (16:9 on screen); a drawn frame takes in what lies wholly inside it.
6. Renaming is in a small panel (F2 or the context menu), not in place on the canvas.
7. The paste rule above.
8. All four stacking commands in quick mode, with brackets and arrows as shortcuts; the frame command without a shortcut.

## Known limitations

- A double click on a frame's name does not rename it; renaming is F2 or the menu.
- A frame's name is drawn and taken for frames inside a clipping frame also where the clipping hides the frame.
- A nested frame's name strip lies over its parent's content: a click there on the parent's background takes the nested frame (an element there still wins).
- `frameAt` walks the containers from the root, about 11 ms for 50 frames holding 5,000 elements (Node); it runs once per use (the frame tool, `move-into-frame`, a menu opening), not while dragging.
- The order of sibling frames under a dissolved group, for drops, is that of the group's slot and then their own keys, not the full drawing order.
- On Windows, what a browser reports for Ctrl with a dead key is not checked; the arrows are the shortcuts that work on every layout. On a German keyboard the key right of Ü gives +, so Ctrl and it is `Mod++` (zoom in), not `Mod+]`.
- Fill, line and clipping of a frame cannot be changed yet (the properties panel, F1-16), nor can a frame be resized other than with the selection tool's handles.

## Rejected alternatives

- **A new extension package for frames.** The commands belong with the basics' other structural commands (group, reparent), where the context menu already finds them; the overlay and the tool need what the selection tool knows (the names are its handles). A package of its own would add a dependency and nothing else.
- **Menu entries contributed by extensions** (a flag on commands, or a menu contribution). It would change the interface for what a few entries in the editor's own menu do; the editor shell's menus are later work.
- **Renaming in place**, a text field over the frame's name. It needs a way from the tool to the editor's interface (the double click) or editor code that knows the names' geometry; the panel uses what exists.
- **A drag on the background of a frame that is not selected draws a band** among its contents, the frame being moved by its name or once selected (as some drawing programs do for top-level frames). Tried first: a frame then no longer moved when dragged like any other element, which the routes test (0013) and users of the selection tool (0008) rely on. Shift, which already means "add to the selection", draws the band instead.
- **Selecting frames only by their name.** An empty frame, or one far zoomed in, would be hard to take; a click selecting it is what a user expects of a visible rectangle.
- **Dropping by the dragged elements' centre or bounds.** The pointer is what the user aims with; a big element dragged by its corner would otherwise fall into frames the pointer is not over.
- **A drop target that includes groups.** Groups have no box of their own to aim at; elements are put into a group by grouping.

## Tests

- `packages/extensions/basics/src/frames.test.ts`: a frame around elements with its margin, in the frontmost member's slot, the members in order and unmoved, selected; a frame at a rectangle with elements of its parent; refusals (different containers, locked, bad rectangles, a locked parent); removing a frame keeping order and place; renaming, with an emoji and to nothing, and its refusals; moving out of a frame in front of it, from a nested frame, and the refusals; moving into the frame under the elements and into a given one; `frameAt` with front and back frames, exclusions, a locked and a deleted frame; `move` with a target into and out of frames, a pure change of container and a frame moved into a frame with its contents, and the refusals; a picture sent to the back of a frame with text on top and the frame moved without anything shifting; stepping inside a frame; the shortcuts in quick mode; a frame stop following its frame when moved, framed, moved with an outer frame and when the outer frame is removed. Every command checked to be one step that undo takes back and redo brings back.
- `packages/extensions/basics/src/testing.ts`: the random scenarios draw the new commands and `move` with a target.
- `packages/editor/src/frames.test.ts` (Node, pointer events and keys): dropping into a frame and out again, each one step; staying in the frame while the pointer stays in it; no drop into a locked frame; a frame taken and dragged by its name; a click on the background selecting the frame, a band among its contents with Shift, a Shift-click adding and removing the frame, a drag between selected elements moving them and not the frame, a drag on the background moving the frame; the frames on screen for their names, nested ones too; the frame tool drawing a frame around what is inside its rectangle (one step, selected, the selection tool back) and a click making a 480 × 270 frame inside the frame under it; the stacking keys inside a frame (Ctrl+Å, Ctrl and the dead key, Ctrl+Shift+ArrowDown, Ctrl+Shift+] as a US keyboard sends it), each one step, none at the front; the context menu framing, restacking, moving out and in and removing a frame, each one step; the rename panel opened from the menu and with F2; a right click on a frame's name selecting it, a locked one too, an element over the name winning; pasting into a selected frame, into the container of the selection (centred in the frame), into the frame in view when the source is out of view, and back next to the copied element.
- `packages/editor/src/keymap.test.ts`: a dead key alone, with Shift and with AltGr names nothing; the stacking shortcuts on a Norwegian keyboard by place (Å, the dead key, with Shift), by AltGr on Linux, with the arrows, and with Cmd on macOS.
- `packages/editor/src/clipboard.test.ts` and `selection.test.ts`: updated for the paste rule (what was copied out of sight in a frame now lands on the canvas in view) and the menu's entries.
- `tests/e2e/frames.spec.ts` (Playwright, the development page; Chromium and Firefox, and WebKit where Playwright's WebKit runs): a text and a picture; a frame drawn around them with the frame tool, taken back by Ctrl+Z and brought back; the picture sent to the back with Ctrl+Shift+[ so the text is on top, undone and redone; the frame dragged by its name with the picture and the text moving by exactly as much and keeping their order, undone; the text dragged out to the canvas, undone, and dragged out and back in; Ctrl+[ and Ctrl+] restacking without the page going back in its history; Ctrl and Å and Ctrl and the dead key as a Norwegian keyboard reports them; Ctrl+ArrowDown and Ctrl+ArrowUp; the frame renamed from the context menu's "Rename frame…" with the panel's field and Enter, undone; no errors in the console.
- `tests/e2e/webkitgtk/frames_check.py`: in the system's WebKitGTK under Xvfb, with real input: the frame tool around a picture and a text, one step; Ctrl+Shift+] and Ctrl+Shift+[ restacking in the frame, each one step; the frame dragged by its name with everything in it moving by as much, and Ctrl+Z; the text dragged out to the canvas.
