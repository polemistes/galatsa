# 0015 Presentation mode

- Status: proposed
- Date: 2026-11-27 (revised the same day after the review: the camera when the goal moves, the keyboard, full screen)
- Code: `packages/player` (`@galatsa/player`, and `@galatsa/player/core` for the part without the DOM); `EditorServices.presentation` and `PresentationRequest` in `packages/extension-api`; `present.ts`, `Editor.setPresenter`, `Editor.present`, `Editor.presenting` and `Editor.viewing` in `packages/editor`; the commands `present` and `present-from-here` and the panel's button in `packages/extensions/routes`; `RendererOptions.textEditing` in `packages/renderer`; `scripts/lib/viewer-bundle.test.ts`; `tests/e2e/presentation.spec.ts`; `tests/e2e/webkitgtk/presentation_check.py`

## Context

A document has stops and routes ([0001](0001-document-model-and-file-format.md) section 6), the editor can make and order them ([0013](0013-routes-and-stops.md)), and there are transitions with a comfort guard and a way to break a transition off without a jump ([0005](0005-extension-interface.md) section 7). What was missing is presenting: full screen, next and previous with the keyboard, a clicker and touch, leaving the route freely and coming back, jumping to a stop, changing route, a laser pointer and notes for the one who presents.

The users' fixed frames that matter here: free presentations are the most important thing the program does; the program has no AI functions; nothing in the interface is hard-coded text; and the player that is later embedded in exported files and shown on the web must not be a second implementation. The package's own criterion: no input during a transition may give a jump or a lock, and leaving the route in the middle of a transition must work.

## Decision

### One player, and the editor presents with it

Presentation mode is `packages/player`. It takes a document through read interfaces only, loads the viewing parts of the extensions only (element types and transitions through a `ViewHost`), and imports no Yjs, no document operations, no Svelte and no editor. The editor does not have a presentation mode of its own: it starts the same player over the page on its live document (`present.ts`). A player of a file is the same code over a snapshot (`sourceFromSnapshot`, `sceneFromSnapshot`). `scripts/lib/viewer-bundle.test.ts` bundles the player and fails if editing code comes with it.

The package has two entries:

- `@galatsa/player/core`: the presentation without the browser: what it reads of a document (`model.ts`), the state (`presentation.ts`), the camera (`playback.ts`, with `steer.ts`) and free roaming (`roam.ts`). No DOM, no renderer. Time is a number the caller passes in, so everything here is tested in Node.
- `@galatsa/player`: the core plus the player in a page (`mountPlayer` in `player.ts`): the stage (`stage.ts`), keys (`keys.ts`), pointers, full screen, the laser pointer and the notes (`notes.ts`). Plain DOM.

### What the player reads

```ts
interface PresentationSource {
  stopsAndRoutes(): Pick<DocumentSnapshot, "stops" | "routes">;
  readonly resolver: Resolver; // positions, containers, offsets
  nameOf?(id: ElementId): string; // a frame stop without a name is called by its frame's
}
```

with a `SceneSource` for the renderer ([0004](0004-rendering-engine.md)), an optional `ImageSource` and `SceneAssets`, and an optional `watch` through which the owner of a document that changes says which elements to read again. The editor gives its live resolver, its scene, `stopsAndRoutesOf(doc)` and one report per change of the document; a file gives a snapshot and no `watch`.

Steps are read with the model's own functions (`routeSteps`, `stopRegion`, `hiddenAt`). A stop is shown by fitting its region to the screen, centred, keeping its proportions, with no margin (0001 section 6.2), within the zoom range and the precision budget of the space the region is in (`viewOfRegion`). A stop whose frame record is missing entirely is skipped (0001 section 6.2). Notes are shown as plain text (the text runs joined).

### The state of a presentation

The state is the route, the step shown last, the step the camera is on its way to, and one of three phases:

| Phase     | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| `stop`    | The camera shows a stop of the route.                                                         |
| `moving`  | It is on its way to one, along that stop's transition.                                        |
| `roaming` | The presenter moved the camera. The route is paused; what the last stop showed and hid stays. |

Every input is accepted in every phase and at any time:

| Input                    | At a stop, or moving                                                                                                                                                                | Roaming                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| next                     | The step after the one shown (or headed for). After the last step: nothing.                                                                                                         | The step after the one shown last; if that was the last, back to it.      |
| previous                 | The step before. At the first: nothing.                                                                                                                                             | Back to the stop shown last.                                              |
| back                     | Nothing.                                                                                                                                                                            | Back to the stop shown last.                                              |
| go to step N             | That step, along its stop's transition. The step the camera is already on its way to: nothing changes.                                                                              | The same.                                                                 |
| another route            | If it visits the stop shown last: that visit (its first), the camera stays. Otherwise its first stop.                                                                               | The same; if it visits the stop shown last, the camera stays where it is. |
| pan, zoom, pinch         | The camera follows at once; the phase becomes `roaming`.                                                                                                                            | The camera follows.                                                       |
| reduced motion on or off | A running transition goes on to the same goal under the new settings.                                                                                                               | A camera still coming to rest stops where it is.                          |
| the screen changes size  | The stop is fitted again (at once at a stop; a transition is steered onto the new fit, without braking).                                                                            | The camera stays.                                                         |
| the document changes     | Routes, steps, regions and what is hidden are read again; the presentation stays at the same visit where it still exists. A transition whose goal did not move goes on undisturbed. | What the last stop hides is shown anew only if the change altered it.     |

Two presses of "next" in quick succession go two steps on: a press counts from the step the camera is heading for. When the presenter takes the camera in the middle of a transition, the route is paused at the stop that was shown last, not at the one the camera was heading for, so "next" then goes to the stop the presenter was on the way to. A document without routes, or a route without stops, is presented too: the camera is the presenter's from the start.

The transition played on the way to a stop is that stop's own (0001 section 6.1), whichever stop the camera comes from; a stop that names none, or one whose extension is not loaded, flies (`DEFAULT_TRANSITION`).

### The camera

`Playback` plays the transitions as 0005 section 7 requires of a player:

- A transition from rest is planned from the view on screen to the goal, both carried into the space of the lowest common ancestor of the two views' spaces, and wrapped in `guardComfort`. When it ends, the camera is set to the goal exactly, in the space the goal is anchored in.
- A transition that is running when another goal is chosen (next, previous, a jump, another route, a new screen size) is continued with `breakOff(running, time, comfort, next)`, in the space the running motion is in. A flight slows down along its path and the next transition starts from where it rests; a cross-fade settles between its own two views. The result can be broken off again.
- A change of the comfort settings during a transition breaks it off with the new settings and the same goal.
- **When the goal is seen anew** (`Playback.follow`): the document changed, or the screen changed size, while the camera is on its way to a stop. The same goal (the same view) leaves the motion alone; if only what the stop hides changed, that is taken over on arrival without touching the motion. Breaking off here would be wrong: every edit anywhere in the document (another window, another user) would slow the flight down, and edits that come faster than the braking time would hold the camera still. A goal that moved is **steered onto** (`steer.ts`): a correction is laid over the running motion that grows, along a cubic curve that starts with the correction's present speed and ends at rest, to the whole move of the goal by the end of the motion (or `MIN_STEER_MS`, 400 ms, from now, but never more than that past the motion's own end, so a goal that keeps moving cannot keep the camera from arriving). A view of the motion gets the correction in proportion to how much closer to the goal it is than the view on screen was when the steering began, so the views the motion started from or rests at stay where they are and the goal gets all of it, the same in a flight and in a cross-fade. A new screen size is always steered onto. A move the document made is steered onto when it is small (less than `STEER_LIMIT`, half a screen width plus zoom as a natural logarithm, and slow enough in the time left); a larger move is a new goal and the motion is broken off as above.
- **Taking the camera in the middle of a transition.** The running motion is broken off without a next transition, so it comes to rest by itself (within 600 ms, 0005 section 7.1), and what the presenter does is laid over it as a change on screen: a scale about the centre of the screen and a shift in pixels (`Nudge`, `roam.ts`). The camera therefore follows the hand at once, while what is left of the flight's speed dies away under it; neither waits for the other. If another goal is chosen before it has come to rest, the nudge is made part of the motion and that is broken off as above. In a cross-fade both views are nudged.
- **At rest**, a pan or zoom changes the view directly, and the view is anchored in the innermost shown frame around its centre, as the editor's camera is ([0009](0009-camera.md)), with the zoom clamped to the range and to the precision budget there. So the whole zoom range is there inside a frame far from the root also while roaming.
- A transition that throws while planning shows its goal at once; one that throws while drawing shows where it was heading. A duration that is not a number is no duration.

Time is passed in with every call. The state of the camera is a function of what was asked and when, which is what makes "no input gives a jump" testable.

### What a stop shows and hides

A stop's changes are applied on arrival and add up from the start of the route (`hiddenAt`), so a jump gives the same picture as walking there. While the camera flies, what the last stop showed stays, and the changes of the goal appear when it arrives. In a cross-fade each of the two views is drawn with its own state, so what the goal shows fades in with it. If a cross-fade is broken off, a view that has been on screen keeps what it showed until the camera has come to rest (the first state a view was given in a chain of broken-off transitions counts), so nothing appears or disappears in a half-transparent picture. Several builds at one view are consecutive stops with the same view: the transition between them has no length, so the change is a cut.

Hiding a container hides what the user sees inside it; a gone container hides nothing (0001 section 6.4). The stage lays the hidden elements over the document as the renderer reads it (they read as gone) and tells the renderer which elements to read again; the document is not touched, and the editor's own view of it is not affected.

### The stage

One `CanvasRenderer` draws through the camera. A cross-fade is two layers: a still picture of one view (a second canvas, copied from the first) over the canvas with the other, and the layer's CSS opacity follows the mix. The two views of a cross-fade stand still, so each is drawn once and the fade costs no drawing; they are drawn again only when something they show changes (an image arrives, the size changes) or when the presenter moves them. A frame is drawn only while the camera moves or something changed.

### Keys, clickers, mouse and touch

Clickers are keyboards. Most send PageDown and PageUp, some the arrow keys, and their "blank screen" button sends B or a full stop.

| Key                             | What it does                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| →, ↓, PageDown, Space, Enter, N | Next                                                                                                                                       |
| ←, ↑, PageUp, Shift+Space, P    | Previous                                                                                                                                   |
| Backspace, R                    | Back to the stop shown last (after roaming)                                                                                                |
| Home, End                       | The first stop, the last stop                                                                                                              |
| digits, then Enter              | That stop of the route                                                                                                                     |
| G                               | The list of stops and routes, open and closed                                                                                              |
| B, .                            | A black screen, on and off; any other key, a click or a tap lifts it and does nothing else; a stop's number and Enter lift it and go there |
| L                               | The laser pointer                                                                                                                          |
| M                               | Reduced motion                                                                                                                             |
| S                               | The presenter's notes                                                                                                                      |
| F                               | Full screen                                                                                                                                |
| +, −                            | Zoom about the middle of the screen (roaming)                                                                                              |
| Escape                          | In full screen: leaves full screen. In a window: ends the presentation                                                                     |
| Tab, Shift+Tab                  | Go round the player's own controls (the keyboard never leaves the player)                                                                  |
| F5, Ctrl+R, Cmd+R               | Nothing: kept from the browser, so the page is not reloaded                                                                                |

Keys with Ctrl, Alt or Cmd are left to the browser, except those that reload the page (F5 with any modifier, Ctrl+R, Cmd+R, the keyboard's reload key), which are kept from it while presenting: a presenter presses F5 again out of habit, and some clickers send F5 from their start button. A letter is read by the character it gives, or by its place on a keyboard without Latin letters. The clicker's keys (the arrows, PageUp and PageDown, Space, Home and End) are always the presentation's: they never press a button, move in the list of stops or change the route chosen in it, so a clicker goes on working wherever the keyboard is. A button that has the keyboard keeps only Enter; the list of routes keeps no key. The key names in the controls' tooltips are translated, and Backspace is called delete on a Mac (`PlayerOptions.mac`; the editor passes its platform).

While the player runs, everything else in the page (the editor) is `inert`: no focus, no keys and no clicks reach it, so nothing in the document can be changed unseen under the presentation, and Tab cannot take the keyboard there. Tab and Shift+Tab go round the player's own controls, and focus that lands outside the player comes back to it. In full screen the browsers keep Tab inside anyway; this is for a presentation in a window (full screen refused or left, or the notes open).

- **Mouse.** A click goes on. A drag moves the canvas. The wheel moves the canvas, and zooms about the pointer with Ctrl or Cmd (which is also what a pinch on a trackpad sends), with the editor's steps (0009). The controls show while the mouse moves and go away after 2.5 seconds.
- **Touch.** A tap goes on; a tap in the left quarter of the screen goes back; a tap along the lower edge brings the controls. One finger moves the canvas; two fingers move and zoom it, and the point between them stays between them.
- **Controls** (a bar at the lower edge): previous, the position ("3 of 12", which opens the list), next, back to the stop, the laser pointer, reduced motion, notes, full screen, end. Messages (the route is paused, reduced motion is on) are shown for a moment at the upper left. When the browser left full screen without the player asking, a button "Back to full screen (F)" stands at the top until it is back.
- **The list of stops** keeps the keyboard on the stop it was on when the document changes (by its visit, not by its place in the list).

### Full screen and Escape

The editor asks for full screen when it starts the presentation (the browser grants it because the start is a key press or a click); if it is refused, the presentation fills the page instead. **Leaving full screen never ends the presentation**: it goes on in the window. When the player itself asked to leave (the F key, or a notes window that the browser leaves full screen for), nothing more happens. Otherwise (a projector cable that falls out, a change from mirrored to extended screens, Escape, the browser showing something of its own) a clear button "Back to full screen (F)" is shown until full screen is back; the presentation is not taken away from the audience, and F5 from the editor would have started it from the first stop.

**Escape in full screen leaves full screen; Escape in a window ends the presentation.** The browsers leave full screen on Escape whatever the page does, and do not agree on telling the page: Chromium sends the key while still in full screen (the player then leaves full screen itself, which is the same), Firefox and WebKitGTK do not send it at all. With this rule Escape means the same in every browser: the first press from full screen takes the presentation into the window with the button back, the next ends it. WebKitGTK also leaves full screen on F by itself without telling the page, so there the button shows after F too.

The player asks the browser to keep the screen awake while it runs (`navigator.wakeLock`, where there is one).

### The laser pointer

A red dot with a glow, 14 pixels, where the pointer is. While it is on, the mouse cursor is hidden over the stage and a drag points instead of moving the canvas (the wheel still moves it). With touch, the dot is where the finger is while it is down.

### Notes for the presenter

The notes are a **window of their own**, opened by the presentation's page (`window.open`) and drawn by it: the time, the time used (with a button to set it back), the position and the stop's name, whether the route is paused, the stop's notes, the name of the next stop, and buttons for previous, back and next. Keys pressed in the notes window go to the presentation. The notes window is closed when the presentation's page goes (`pagehide`: reloaded or closed), so no window is left with buttons that do nothing.

Why this: with two screens, the presenter drags the notes window to their own screen and puts the presentation in full screen on the audience's; that is the case notes are for, and it works in every browser today without anything installed. Because the page that presents draws the other window directly, there is no second program, no channel between windows and no protocol to keep in step, and the notes are always exactly the state of the presentation. It is also what the desktop shell can later do with a second native window, with the same view (`notes.ts` builds into any document it is given).

A new window takes the browser out of full screen, so the order is: open the notes (S), then full screen (F). Where the browser does not open the window (a pop-up blocker), the same view is shown over the presentation, with a line that says why.

Rejected for now: a presenter view inside the same window (the audience would see it when the screen is mirrored, and with two screens it is on the wrong one); the Presentation API and the Window Management API (not in all browsers, and they need permissions); a second page of the program opened with a URL and kept in step over a `BroadcastChannel` (a second entry point and a protocol, for the same result).

### From the editor

- **`EditorServices.presentation`** (new in the extension interface): `start(request?)` starts presenting the open document (`{ route?, step? }`; without them the first route from its first stop) and returns false when it did not start; `active()` tells whether a presentation is running. The editor hands the document to the player through a function the page sets (`Editor.setPresenter`, as `setCanvasFocus`: presenting needs the page, and the editor core does not touch the DOM); `mountEditor` sets it. One presentation at a time. When it ends, the canvas gets the keyboard back.
- **Commands**, in the routes extension, which knows the route shown and the chosen step: `galatsa.routes/present` (`F5`; arguments `{ route?, step? }`; the route shown, from its first stop) and `galatsa.routes/present-from-here` (`Shift+F5`; the route shown from the chosen step, from the start when none is chosen). Neither is an undo step, and both are disabled while a presentation runs. F5 and Shift+F5 are what other presentation programs use; they are not Alt with a letter (E10). The routes panel has a button "Presenter" that runs `present-from-here`.
- The editor's host now loads the built-in transitions (`@galatsa/extension-transitions`, viewing only), so the player finds the transition a stop names.
- A gesture left open when the presentation starts is cancelled, and text being edited in place is committed and its editing element taken away (`textEdit.end()`). Edits to the document while it is presented (someone else's, later) reach the presentation through the live resolver.
- If the player cannot start (it throws while it builds the stage or reads the document), nothing of it is left in the page (the black cover, its listeners and the inert editor are undone), `start` returns false, and the editor shows the notice "The presentation could not start." (`editor:present.failed`).
- `present-from-here` counts the chosen stop as the player does: stops that show nothing are not counted, and a chosen stop that shows nothing starts at the next one.

### Changes outside the package

- **`@galatsa/extension-api`.** `PresentationService`, `PresentationRequest` and `EditorServices.presentation` are added, and `createTestServices` records the presentations started (`state.presentations`). The addition is additive. **`EXTENSION_API_VERSION` was left at 1.6 on purpose while other packages change the interface at the same time; it must be raised to 1.7 for this addition when they are merged.**
- **`@galatsa/editor`.** `Editor.setPresenter`, `present`, `presenting` and `viewing` (the image source and asset sizes a second view of the document draws from), the two service functions, `present.ts`, one line in `mountEditor`, and the built-in transitions in `loadExtensions`. New dependencies on `@galatsa/player` and `@galatsa/extension-transitions`.
- **`@galatsa/extension-routes`.** The two commands, their texts, and the button.
- **`@galatsa/renderer`.** In-place text editing (F1-08) is passed in by the editor (`RendererOptions.textEditing`, `domTextEditing`), so a renderer in a player does not carry the editing code. The editor passes it; nothing else changes for it.
- **`tests/e2e/playwright.config.ts`.** The new test file in the Firefox and WebKit projects.

### The size of the player

`scripts/lib/viewer-bundle.test.ts` bundled what a player imports from the extension interface and the extensions' viewing parts, with a limit of 100 kB unminified until the player's real budget is set (F2-02). It did not include a renderer or a player, since there was none. It now also bundles `packages/player`, in two steps, and checks in both that no editing code, no Yjs, no Svelte and nothing of the editor is there. Measured 2026-11-27, unminified:

| Bundle                                                                                   | First  | After the review |
| ---------------------------------------------------------------------------------------- | ------ | ---------------- |
| The viewing host and the extensions' viewing parts (as before)                           | 91 kB  | 91 kB            |
| The same with the player's core (the presentation, its camera, `breakOff`, the resolver) | 156 kB | 162 kB           |
| The same with the whole player (stage, input, notes), the renderer and the translations  | 304 kB | 338 kB           |

The growth after the review is the renderer's text layout from F1-08 (a player has to draw text) and the fixes (steering, the keyboard, full screen). F1-08 also brought the renderer's in-place text editing into the player (355 kB); that is now passed in by the editor and checked for (`DomTextEditSession` among the marks of editing code).

**Both bundles with the player are over the 100 kB limit.** The limit was not raised: the first bundle is still held to it, and the two new ones have ceilings a little above what was measured (165 kB and, raised after the review for the growth above, 350 kB), which are tripwires against growth nobody noticed, not budgets. The largest parts are not the player's own: the renderer is 95 kB alone, the model's resolver and routes 30 kB, the translation runtime 20 kB, the shapes' viewing part 44 kB. The budget, and what to do about the parts (minified sizes, loading shapes on demand), is F2-02's.

### Behaviour for the users that Claude chose

To be put to the users ("brukeratferd, Claudes valg"):

1. F5 presents the route shown in the routes panel from its first stop, Shift+F5 from the chosen stop; the panel's "Presenter" button does the latter.
2. The keys in the table above, among them: Backspace (and R) is the one key back to the stop; B and the full stop make the screen black; M switches reduced motion; L the laser pointer; S the notes; G the list.
3. Escape in a window ends the presentation, also when the list is open or the screen is black. Escape in full screen only leaves full screen. Leaving full screen never ends the presentation; when the player did not ask for it, a button back to full screen is shown until it is back. (Changed after the review: first, Escape always ended it and so did any leaving of full screen the player had not asked for.)
4. After the last stop "next" does nothing (no closing black slide), and before the first "previous" does nothing.
5. Every press counts: pressing "next" twice during a transition goes two stops on.
6. While roaming, "previous" returns to the stop shown last instead of going one further back, and "next" goes to the stop after it (to the same stop if it was the route's last), so a clicker with two buttons can always get back.
7. When the camera is taken in the middle of a transition, the route is paused at the stop that was shown last.
8. The transition into a stop is used whichever stop the camera comes from, also backwards and after roaming.
9. Show and hide changes appear on arrival after a flight, and fade in with the goal in a cross-fade; builds at one view are cuts.
10. Changing to a route that visits the stop shown stays at that stop and goes on in the new route; otherwise the new route starts from its first stop.
11. A click goes on; a drag moves the canvas; the wheel moves it and zooms with Ctrl, as in the editor. A tap goes on, a tap in the left quarter goes back, a tap along the lower edge shows the controls.
12. The laser pointer is a red dot of 14 pixels with a glow; while it is on, a drag does not move the canvas.
13. The controls show when the mouse moves and hide after 2.5 seconds; messages show for 2.5 seconds.
14. The notes are a separate window with the time, the time used, the position, the notes, the next stop's name and three buttons; no picture of the next stop yet.
15. A document without stops can be presented: the camera starts where the editor's is and is free.
16. The presentation starts in full screen from the editor, and the editor's own camera is where it was when the presentation ends.
17. The clicker's keys (the arrows, PageUp and PageDown, Space, Home and End) never work a control in the player: a button keeps only Enter, and the list of stops is moved in with Tab. Space does not press a button.
18. A stop's number and Enter lift the black screen and go to the stop; a click or a tap lifts it and does nothing else.
19. While presenting, F5, Ctrl+R and Cmd+R do nothing, and the editor under the player is inert.
20. A goal that moves while the camera is on its way is steered onto: always for a new screen size, and for a move by the document below half a screen; the correction is spread over what is left of the transition, at least 400 ms.
21. Backspace is called "Tilbake" in Norwegian and "delete"/"slett" on a Mac in the tooltips.

## Known limitations

- **No picture of the next stop** in the notes, only its name. The renderer's `renderRegion` can make one; the route strip with thumbnails belongs to the editor shell.
- **Notes are plain text.** Formatting in notes is not shown.
- **A second renderer while presenting from the editor.** The player has its own renderer and image cache, so while a presentation runs the decoded images may be held twice (within each cache's budget). The player's renderer is not told when image bytes arrive in the editor's store (`imagesChanged`); it asks again by itself after a wait, as a renderer does for a missing image (0004).
- **Views far apart in different frames.** A transition is planned in the space of the lowest common ancestor of the two views, and one that is broken off is continued in the space it was planned in. A goal deep inside a frame far from that space loses precision there until the camera arrives, when it is set exactly in the goal's own space. Such a transition is a cross-fade by the comfort limits, so nothing is seen of it.
- **The camera does not follow an anchor frame that moves while roaming** (an edit by someone else during a presentation): it is in that frame's space and moves with it.
- **Safari's gesture events** (a pinch on a trackpad in Safari) are not handled by the player yet; Ctrl with the wheel and two fingers on a touch screen are.
- **The user's comfort settings** have nowhere to be stored yet: the player uses the defaults with the system's setting and the presenter's toggle; `PlayerOptions.preferences` takes the stored ones when there is a settings view.
- **Escape with the list open** ends the presentation in a window (see "Full screen and Escape"); in full screen it leaves full screen first.
- **WebKitGTK leaves full screen on F by itself**, without telling the page, so the player cannot tell it from a lost full screen and shows its button back.
- **Steering a cross-fade** moves the incoming view a little while it fades in, also with reduced motion (only when the screen size or the stop changed during it). The correction is not checked against the comfort limits again; it is small by construction (`STEER_LIMIT`, `MIN_STEER_MS`).
- **No rehearsal aids** (a timer per stop, a countdown), and no choice of screen for full screen: the browser puts it on the screen the window is on.
- **The bundle is over the limit** (see "The size of the player").
- The reader of the stops reads all stops and routes again on every change of the document while presenting, as the routes panel does; slow with very many stops, not measured.

## Tests

- `packages/player/src/presentation.test.ts` (Node, 37 tests over a document with frames at the root, inside each other and 2^40 from the root, two routes that share stops and an empty one): start, names and notes; next, previous and the ends of the route; two quick presses; arrival exact in the stop's own space, and a flight planned in the space of a far frame; jumps; a cut; an unknown transition; a transition that cannot plan and one that cannot draw; show and hide on arrival, counted from the start, the two states in a cross-fade, and the last stop's state while roaming; roaming at rest, back, next and previous while roaming; the point under the pointer when zooming and pinching; taking the camera in the middle of a flight (the picture moves by what the hand moved and by nothing else, it comes to rest within the braking time, and "next" goes on) and in the middle of a cross-fade, and again while it is still slowing down; anchoring in a frame far from the root with the zoom range that is not there at the root; a document without stops; another route at a shared stop, at a stop it does not visit, in the middle of a transition, while roaming, and an empty one; reduced motion from the presenter and from the system, switched on in the middle of a flight (only the view on screen and the goal are shown from then on) and off in the middle of a cross-fade; a new screen size at a stop, in a transition and while roaming; the route and a stop changed under the presentation, the route gone, no route left, and a change in the middle of a transition. After the review: the document changing every 200 ms during a 3.6 s flight without moving its goal (every frame exactly as without the changes, arriving at the same moment), the goal moved a little every 200 ms (arriving within the flight's time and 400 ms), what the goal hides changed in mid-flight (taken over on arrival, the flight untouched), the stop the camera is heading for chosen again (nothing changes), and the screen growing every frame during a flight and going to full screen 20 ms before its end (steered, arriving at the new fit).
- **Random input in the middle of transitions** (same file): 60 seeds of 50 inputs each (next, previous, back, a jump, another route, reduced motion on, off and as set up, pan, zoom, pinch, a change of the document elsewhere, a stop moved a little or far, a new screen size), with random waits that are mostly too short for the transition to end. Every 5 ms the picture is compared with the one before: no picture may differ from the last by more than the fastest transition can change it in that time (two views by their distance on screen and zoom; a cross-fade by how much of the picture changed hands), and no input except the presenter's own pan and zoom may change the picture at the moment it is pressed. After each sequence a jump to a random stop must end at that stop exactly, with exactly what the route hides there. Further: what is hidden changes only where the camera is at rest or fading (30 seeds); and from every stop to every other, a jump to a third stop 1, 120 and 450 ms into the transition arrives exactly (126 cases).
- `packages/player/src/keys.test.ts`: what clickers send, the other keys, keys left to the browser, letters by place on a keyboard without Latin letters; the keys that reload the page; the time used in digits.
- `packages/editor/src/present.test.ts`: no start without a page; start through the service, once at a time, and the keys back when it ends; a presenter that cannot start, and one that throws (a notice); ending with the editor; the built-in transitions in the editor's host. `text-edit.test.ts`: in-place editing ends, keeping what was typed, when a presentation starts.
- `packages/extensions/routes/src/routes.test.ts`: F5 presents the route shown from its first stop without an undo step and is disabled while presenting; Shift+F5 from the chosen stop, counted without stops that show nothing; a given route and step, and a route that is not there; a document without routes; a failure when there is nowhere to present.
- `scripts/lib/viewer-bundle.test.ts`: the player's core and the whole player bundled with the extensions' viewing parts, without editing code (the renderer's in-place text editing included), Yjs, Svelte or the editor.
- `tests/e2e/presentation.spec.ts` (Playwright, the development page; Chromium and Firefox, and WebKit where Playwright's WebKit runs), five tests: (1) F5 starts the player in full screen on the route chosen in the panel; PageDown, the arrows and PageUp; what a stop shows and hides, read from the colour in the middle of the canvas; the black screen with B and the full stop; a number and Enter; Home and End; nothing after the last stop; the list with the stops' names, Tab in it, the clicker's keys driving the presentation from it, and Enter; another route that visits the stop shown, and the clicker's keys on the route chosen, which never change it; Escape in full screen leaving it with the button back, then Escape back to the editor with the keys and with no undo step. (2) Keys pressed in the middle of transitions, with every picture the stage drew recorded and no step larger than a transition can make, and the frames' colours read back from the canvas where those pictures put them; the mouse taking the camera in the middle of a flight, the route paused, Backspace back to the stop; the wheel and Ctrl with the wheel, and "next" from roaming; a click; the controls; reduced motion with the still layer of a cross-fade, seen part of the way and fading one way, and only its two views shown. (3) The panel's button and Shift+F5 from the chosen stop; the laser pointer under the mouse, and a drag that does not move the canvas; touch taps on the right and in the left quarter, and two fingers that zoom by three about the point between them; the notes in a window of their own with the notes, the position, the next stop, the time and the time used, driven from that window with its buttons and keys, closed with its window and with the presentation. (4) Out of full screen: the editor inert, Tab and Shift+Tab many times staying in the player, then PageDown, Delete (no undo step) and Escape; F5, Shift+F5, Ctrl+R and Ctrl+Shift+R kept from the browser. (5) Full screen lost without the player asking: the presentation goes on with the button, which takes it back; a click and a stop's number lift the black screen; the list keeps the keyboard on its stop when the route changes; the notes window closes when the page is reloaded. No errors in the console.
- `tests/e2e/webkitgtk/presentation_check.py` (the system's WebKitGTK, the engine of the Linux desktop app, with real keys and a real mouse through xdotool): F5 and full screen; PageDown, the arrows and PageUp; keys in the middle of a transition, ending exactly at the stop; a drag in the middle of a flight, the route paused, and Backspace; the wheel and "next" after roaming; out of full screen, the editor inert and Tab staying in the player, and the clicker after Tab; reduced motion; a click; the notes shown over the presentation, since that window opens no other; Escape in full screen leaving it with the button back, and Escape back to the canvas.

## Rejected alternatives

- **Breaking a transition off whenever the document changes** (the first version): every edit anywhere slowed the flight down, and edits faster than the braking time held the camera still in mid-flight. Breaking off is kept for a goal that really moved far.
- **Planning a new transition from the view on screen when the goal moves a little**: the speed jumps. Steering keeps the motion and lays a correction over it.
- **Ending the presentation when full screen is lost** (the first version): a loose cable or a change of screens showed the editor to the audience, and F5 would start again from the first stop.
- **A presentation mode inside the editor**, driving the editor's own canvas: the player of a file would then be a second implementation, the editor's overlays and gesture previews would have to be kept out of the picture, and a cross-fade needs layers the editor's canvas does not have.
- **Planning the next transition from the view on screen** when one is interrupted: it stops a flight dead from full speed and makes a cross-fade jump to one of its views (0005 section 7).
- **Waiting for a broken-off transition to come to rest before the presenter's hand moves the camera**: up to 0.6 seconds in which nothing follows the hand is a lock.
- **Two renderers for a cross-fade**: two scene trees and two image caches for the whole presentation, to draw two pictures that stand still.
- **Drawing a cross-fade with canvas alpha per element**: overlapping elements would show through each other; a cross-fade is a blend of two finished pictures.
- **Changing the document to hide elements**: a presentation must not make undo steps or edits that other users see.
- **The present command in the editor's own built-in extension**: it would not know the route shown or the chosen step, which are the routes extension's.
- **Escape closing the list or lifting the black screen first**: it cannot be kept in full screen (see above).

## New dependencies

None from outside the workspace. `@galatsa/player` depends on `@galatsa/core`, `@galatsa/extension-api`, `@galatsa/extension-transitions`, `@galatsa/i18n` and `@galatsa/renderer`.
