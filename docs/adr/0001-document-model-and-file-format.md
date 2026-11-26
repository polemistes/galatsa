# 0001 Document model and file format

- Status: proposed, revised after the first review
- Date: 2026-11-26
- Code: `packages/core/src/model` (types, order keys, resolution, stops and routes, validation, purging, fragments, zoom range), `packages/core/src/ydoc` (the Yjs binding, exported as `@galatsa/core/ydoc`), `packages/format` (the file format; `@galatsa/format/read` reads without Yjs)

## Contents

1. Context and summary
2. The document and its layout in Yjs
3. Elements
4. Z-order
5. Containers, structure and concurrent edits
6. Stops and routes
7. Coordinates, zoom range and numeric precision
8. Assets
9. File format
10. Undo
11. Where the code lives, and dependencies
12. Assumptions
13. Open questions and known limitations
14. Rejected alternatives
15. Tests

The key words MUST, SHOULD and MAY are used in their usual sense (RFC 2119).

## 1. Context and summary

Galatsa is a presentation program built around an infinite canvas. The presenter places elements on the canvas, moves a camera over it, and saves routes of camera stops. A canvas can have several routes, and routes can share stops. The program works fully offline and without an account. Real-time collaboration (Yjs over WebSocket), offline editing that merges later, and viewers that receive snapshots come later, but the document model has to allow all of them from the start, because changing the stored model later means migrating every user's files.

Element types (text, shapes, images, freehand drawing, tables, charts, maps, media) are provided by extensions. A file may contain elements from an extension the reading program does not have; those must survive loading and saving untouched.

The decisions, in short:

| Topic                    | Decision                                                                                                                                                                                                                                                                  | Section |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Storage                  | One Yjs `Y.Doc` per document. Flat maps of elements, stops, routes and assets keyed by random ids.                                                                                                                                                                        | 2       |
| Element structure        | A fixed envelope that core understands (type, parent, order, position, size, rotation, name, lock, revision, removal, references, open `ext` slots) plus type-specific `data` that only the extension understands.                                                        | 3       |
| Z-order                  | A fractional order key per element, among its siblings, in a fixed syntax. No arrays of children.                                                                                                                                                                         | 4       |
| Frames and groups        | Containers with a translation-only local coordinate space. Moving an element writes only its position; changing its container writes only its parent and a recorded translation, so a concurrent move and reparent both survive.                                          | 5       |
| Concurrency of structure | Every replica resolves the merged state with the same pure function: orphans go to the root, parent cycles are broken deterministically, positions written in another space are converted.                                                                                | 5       |
| Deletion                 | Soft, and "observed-remove": a delete removes only what the deleting user saw, as they saw it. Anything another user changed or added concurrently, inside or on the deleted thing, survives. Ungroup dissolves the container, and a dissolve beats a concurrent delete.  | 5.5     |
| Tidy up                  | Removed records are purged only by an explicit "tidy up" command and in exports for sharing, never by age.                                                                                                                                                                | 5.8     |
| Stops                    | A stop shows a region (a frame, or a rectangle in some container's space), not a camera pose. It holds notes, a transition, and show/hide changes.                                                                                                                        | 6       |
| Routes                   | A route is a set of entries, each pointing at a stop, ordered by fractional keys. Shared stops are stops that more than one route points at.                                                                                                                              | 6.3     |
| Visibility               | Show/hide changes add up along the route. An element first shown at a stop is hidden before it; in a route that skips that stop, it is visible from the start.                                                                                                            | 6.4     |
| Precision                | float64 throughout; parent-local coordinates; every conversion goes through the lowest common ancestor; the camera and stop regions are anchored in a container's space; rendering is camera-relative. Zoom 2^-32 to 2^32, clamped further where precision would run out. | 7       |
| Assets                   | Identified by the SHA-256 of their bytes. The document holds descriptions; bytes are stored beside it, embedded in the file by default or, for very large media, in a file next to it.                                                                                    | 8       |
| File                     | A zip archive: `mimetype`, `manifest.json` (format version, minimum reader version, merge identity), `document.json` (canonical, plain JSON), optional `ydoc.bin` (Yjs state, to keep merge identity), `assets/`, `thumbnail.png`.                                        | 9       |
| Versions                 | Additive changes go into open slots and need no new reader. Incompatible changes raise the minimum reader version; older readers refuse with a clear message. Old files are upgraded by JSON migrations.                                                                  | 9.4     |
| Merge identity           | A lineage id in the document and the manifest changes whenever identity is reset; copies with different lineages refuse to merge instead of silently losing edits.                                                                                                        | 9.3     |
| Missing extensions       | The element's envelope is used (position, z-order, grouping), its data is kept losslessly and written back unchanged, and a placeholder is drawn. It can be moved, not resized.                                                                                           | 9.5     |

## 2. The document and its layout in Yjs

A document is one `Y.Doc` with six root maps. Everything that two people may change at the same time is a separate key or a separate shared type, so that unrelated changes never overwrite each other.

```
Y.Doc
├─ "meta"      Y.Map    schemaVersion, minReaderVersion, id, title, lineage
├─ "settings"  Y.Map    "<owner>.<name>" -> JSON
├─ "elements"  Y.Map    ElementId -> Y.Map (an element, section 3)
├─ "stops"     Y.Map    StopId -> Y.Map (a stop, section 6)
├─ "routes"    Y.Map    RouteId -> Y.Map (a route, section 6)
└─ "assets"    Y.Map    AssetId -> AssetInfo (JSON, section 8)

element Y.Map
  type, typeVersion, parent, order, pos, rebase, size, rot, name, locked, rev,
  deleted, dissolved, refs            JSON values; last writer wins per key
  ext, data                           Y.Map: per key, a JSON value or a nested
                                      shared type (Y.Text, Y.Map, Y.Array, Y.XmlFragment)

stop Y.Map
  name, view, transition, rev, removed    JSON values
  notes                                   Y.Text
  visibility                              Y.Map: ElementId -> { action: "show" | "hide" }
  ext                                     Y.Map

route Y.Map
  name, order, rev, removed               JSON values
  entries                                 Y.Map: RouteEntryId -> { stop, order } (JSON)
  ext                                     Y.Map
```

Rules that follow from the layout:

- **Granularity.** In a `Y.Map`, concurrent writes to the same key are resolved by Yjs: one value wins, the same one on every replica. Concurrent writes to different keys are all kept. Values that must change together are one JSON value under one key (`pos` holds x, y and the space together; a whole stop `view` is one value), so a merge never mixes half of one user's change with half of another's.
- **No arrays of ids for structure.** Membership is the element's own `parent` key and order is its own `order` key. A container does not list its children (section 14).
- **`meta`.** `schemaVersion` and `minReaderVersion` are the versions of section 9.4. `id` is the document's id: copies of one presentation share it. `lineage` is the merge identity (section 9.3).
- **Settings.** Document-wide settings (background, default transition) are plain JSON under keys named `<owner>.<name>`, such as `core.background`.
- **The JSON form.** `DocumentSnapshot` in `packages/core/src/model/types.ts` is the same structure as plain JSON, without `lineage`. `toSnapshot` and `fromSnapshot` in `@galatsa/core/ydoc` convert both ways. The JSON form is what files store (section 9.3) and what viewers receive.
- **Readers never throw on content.** `toSnapshot` is total: any state a peer can create converts (section 3.4). Missing or invalid order keys and revisions read as fixed defaults (`"a0"`, `"0"`), the same on every replica.
- **Unknown content.** The layout is closed: unknown root types and unknown keys in `meta`, element, stop and route maps are not part of the document. `hiddenContent` lists them; a file whose `ydoc.bin` has any is not trusted (section 9.3). Additive features go into `ext` slots and `settings` (section 9.4).

## 3. Elements

### 3.1 Ids

Element, stop, route and route entry ids, document ids, lineages, revisions and delete actions are opaque strings of 1 to 64 characters from `A-Z a-z 0-9 _ -`, never `__proto__`. New ones are 128 random bits written as 22 URL-safe base64 characters (`newId` in `model/ids.ts`), from the platform's secure random source, so replicas never need to coordinate. Readers MUST NOT give meaning to an id's content. The canvas root is `null`, not an id. All code that builds objects keyed by ids uses own properties (`setOwn`), so no key is special.

### 3.2 Element types

An element's `type` is `"<extension id>/<type name>"`, both parts from `a-z 0-9 . _ -` starting with a letter or digit, for example `galatsa.text/text`. The type never changes after creation. Core defines `core/frame` (section 5.2) and `core/group` (section 5.4).

`typeVersion` (an integer from 1) is the version of the layout of the element's `data`, owned by the extension (section 9.4 for how versions mix).

### 3.3 The envelope

Every element has these keys. Core and every extension understand them; they are what lets an element of an unknown type still be placed, stacked, grouped and drawn as a placeholder.

| Key           | Type                          | Meaning                                                                                          |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `type`        | string                        | Element type id.                                                                                 |
| `typeVersion` | integer >= 1                  | Version of `data`'s layout.                                                                      |
| `parent`      | id or null                    | The frame or group the element is in; null for the canvas root.                                  |
| `order`       | string                        | Order key among siblings (section 4).                                                            |
| `pos`         | `{x, y, space}`               | Top-left corner of the unrotated box, in the local space of the container `space` (section 5.3). |
| `rebase`      | object or null                | Translations recorded when the element changed container (section 5.3).                          |
| `size`        | `{w, h}`                      | Width and height in world units, >= 0. Not on groups.                                            |
| `rot`         | number                        | Rotation in radians about the box centre, clockwise on screen. Only on extension elements.       |
| `name`        | string                        | User-visible name; empty when unnamed.                                                           |
| `locked`      | boolean                       | Locked elements cannot be selected or changed in the editor (section 5.6).                       |
| `rev`         | string                        | Revision: rewritten by every change of the element (section 5.5).                                |
| `deleted`     | `{action, root, rev}` or null | Delete mark (section 5.5).                                                                       |
| `dissolved`   | boolean                       | Containers only: ungrouped (section 5.5).                                                        |
| `refs`        | ids                           | Elements and stops that `data` or `ext` refer to (section 3.5).                                  |
| `ext`         | map                           | Open slots for additive envelope-level features, `"<owner>.<name>"` -> value (section 9.4).      |
| `data`        | map                           | Type-specific data (section 3.4).                                                                |

### 3.4 Type-specific data and the JSON form of shared types

`data` (and every `ext` slot map) is a `Y.Map`. Each value is a plain value (replaced as a whole when written) or a shared type that merges item by item: `Y.Text`, `Y.Map`, `Y.Array`, `Y.XmlFragment` (with `Y.XmlElement`, `Y.XmlText` and `Y.XmlHook`). Shared types can nest in shared maps and arrays, be embedded in text, and be attribute values.

In the JSON form, values in a _value position_ (directly in a data or ext map, a shared map or array, a text embed, or an attribute) are plain JSON or an object with a `"$y"` tag:

| Yjs value                              | JSON form                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `Y.Text`                               | `{"$y": "text", "delta": [runs], "attributes"?: {k: value}}`                           |
| `Y.Map`                                | `{"$y": "map", "entries": {k: value}}`                                                 |
| `Y.Array`                              | `{"$y": "array", "items": [value, ...]}`                                               |
| `Y.XmlFragment`                        | `{"$y": "xmlFragment", "children": [node, ...]}`                                       |
| `Y.XmlElement`                         | `{"$y": "xmlElement", "name": "p", "attributes": {k: value}, "children": [node, ...]}` |
| `Y.XmlText`                            | `{"$y": "xmlText", "delta": [runs], "attributes"?: {k: value}}`                        |
| `Y.XmlHook`                            | `{"$y": "xmlHook", "hookName": "h", "entries": {k: value}}`                            |
| a plain object with its own `"$y"` key | `{"$y": "json", "value": {...}}`                                                       |
| a plain value JSON cannot express      | `{"$y": "any", "value": tree}`                                                         |
| an unknown shared type                 | `{"$y": "unsupported", "note": "..."}`                                                 |

- A run is `{"insert": string or value, "attributes"?: {...}}`. Run attributes are JSON (Yjs stores them as JSON). An embed is a value: a JSON object, or a tagged shared type. `"attributes"` on a text or XML node holds what `setAttribute` stored, shared types included. Together these cover both kinds of editor bindings: those that keep a tree in `Y.XmlFragment` (ProseMirror, TipTap) and those that embed `Y.XmlText` in `Y.XmlText` and use node attributes (Lexical).
- An _any tree_ is the lossless form of values Yjs can store as plain content but JSON cannot: JSON primitives stand for themselves, every other node is an object with exactly one key: `{"a": [...]}` array, `{"o": {...}}` object, `{"u": 1}` undefined, `{"b": "<base64>"}` binary, `{"n": "NaN" | "Infinity" | "-Infinity"}`, `{"i": "<digits>"}` big integer. It is used only when a value is not plain JSON.
- `unsupported` is a quarantine: it lets a save succeed whatever a peer wrote. Writing it back yields null. The reference code produces it only for shared types Yjs itself does not ship.
- Anything nested inside plain JSON is plain JSON, `"$y"` keys included.
- Text deltas are written normalized, as Yjs produces them (adjacent runs with equal attributes merged).

This encoding needs no knowledge of the element type, so `toSnapshot` and `fromSnapshot` convert elements of unknown types losslessly (section 9.5), and conversion never throws, so one odd value from a peer cannot make a document unsaveable.

**Patterns for extension authors.** The tests use them for every planned type:

1. Properties that change independently get separate keys (fill and stroke of a shape).
2. Values that only make sense together are one JSON value (a crop rectangle, a media trim range, a map projection).
3. Text that people edit is a `Y.Text` (or a tree for structured editors).
4. Collections whose items are added, removed and reordered concurrently are a `Y.Map` keyed by random item ids, each item with a fractional `order` key (table rows and columns, chart series, map features). `Y.Array` is only for append-mostly sequences that are not reordered (freehand strokes): concurrent moves in a `Y.Array` duplicate items.
5. Derived data (layout, rendered bitmaps, downscaled images) is never stored.
6. Large binary content is an asset, referred to by its id as a complete string value (section 8.3).
7. References to other elements or stops are complete string values equal to the id, and the id is listed in the envelope's `refs` (section 3.5).
8. Shared types that other users may edit are created together with the element. Replacing one later (`setData` with a new shared value) discards concurrent edits inside the old one, and undoing such a replacement cannot restore them (section 13).

**Provisional layouts of the planned types** (the extension interface work defines the final ones; these are what the merge tests use):

| Type     | `data`                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text     | `text`: Y.Text (paragraph attributes such as alignment and lists on the newline, as in Quill deltas); `fontFamily`, `fontSize`, `color`: JSON           |
| shape    | `kind` (template id), `fill`, `stroke`, `strokeWidth`, `cornerRadius`, `opacity`: JSON                                                                  |
| image    | `asset` (asset id), `crop` (`{x, y, w, h}`), `opacity`: JSON                                                                                            |
| freehand | `strokes`: Y.Array of JSON `{points: number[], color, width}`; `smoothing`: JSON                                                                        |
| table    | `rows`, `cols`: Y.Map id -> JSON `{order, size}`; `cells`: Y.Map `"<row>:<col>"` -> Y.Text                                                              |
| chart    | `kind`, `options`: JSON; `categories`: Y.Map id -> JSON `{label, order}`; `series`: Y.Map id -> Y.Map `{name, order, values: Y.Map category -> number}` |
| map      | `view`: JSON (projection, centre, scale); `features`: Y.Map id -> Y.Map `{kind, geometry (JSON), style (JSON), label (Y.Text)}`                         |
| media    | `asset`, `trim` (`{start, end}`), `autoplay`, `loop`, `volume`: JSON                                                                                    |

### 3.5 References, copy and paste

An element whose `data` or `ext` refers to other elements or stops (a connector, a link, a map label pointing at a frame) stores each reference as a complete string value equal to the id and lists the id in `refs`. Core never interprets references; it uses `refs` to remap them.

Copy, duplicate and paste go through a _fragment_ (`copyFragment` in `model/fragment.ts`): normalized copies of the selected elements and everything visible inside them (positions resolved, no rebases or removal marks, children of gone containers lifted, order keys regenerated), optionally stops, and the descriptions of the assets they refer to. `pasteFragment` (`ydoc/document-ops.ts`) writes it with new ids:

- every element and stop gets a new id; the old-to-new map is returned;
- parents, position spaces, frame stops, rectangle-stop spaces and visibility entries that point into the fragment are remapped; visibility entries for elements outside the fragment are dropped;
- in `data` and `ext`, every string value and map key equal to an id that the element lists in `refs` and that was pasted is replaced; `refs` is remapped the same way; references to things not pasted stay as they were; text of rich text runs is never changed;
- roots go into the target container, moved by an offset, in front of what is there, keeping their relative order;
- records are created like all records (removed, then restored in the local transaction), so undoing a paste removes softly;
- asset descriptions are added to the target document; the caller copies the bytes from the source store into the target store, for every asset id the result lists.

## 4. Z-order

### 4.1 Order keys

Each element has an `order` key that sorts siblings (elements with the same effective parent, section 5.1) from back to front. Keys are compared as plain strings by UTF-16 code unit (never by locale); ties are broken by id, compared the same way. Higher sorts in front.

The key syntax is fixed by the format (`isValidOrderKey` in `model/order.ts`): a head letter giving the length of the integer part (`a`-`z`: 2 to 27 characters, `A`-`Z`: 27 down to 2), the remaining integer digits, then optional fraction digits not ending in `0`, all digits from `0-9A-Za-z`, at most 1024 characters, and never `A` followed by 26 zeros. This is the syntax of the `fractional-indexing` library, which generates the keys. Validation rejects anything else in a file. In a live document, a key that is missing (possible after an undo races a remote change) or invalid (a faulty peer) reads as `"a0"` everywhere, and key generation treats invalid neighbours as open ends, so it never fails.

Generated keys get three random digits appended (when the result still sorts strictly between its neighbours), so two replicas that insert at the same place almost never produce equal keys. Keys grow by about one character per six insertions at the same spot; there is no rebalancing (section 13).

The same mechanism orders route entries and routes.

### 4.2 Stacking rules

- Z-order applies among siblings. A container's subtree is drawn in the container's slot: everything inside a frame is in front of the frame's own background and behind everything in front of the frame.
- Drawing order is a depth-first walk from the root, siblings back to front (`Resolver.drawOrder`). Gone elements (section 5.5) are not drawn; the visible children of gone containers are, in the container's slot.
- What the user sees as the children of a container are its _logical children_ (`Resolver.logicalChildren`): gone containers are replaced by their visible children, in their slot.
- Operations (`ops.ts`) work on logical siblings: bring to front, send to back, one step forward, one step backward. An element that sits inside a gone container (for example a former group member) is first moved out into the visible container (section 5.3), so it can pass its new siblings. Each writes only the moved element's `order` (plus `parent` and `rebase` in that case).

### 4.3 Concurrent reorders

| Concurrent changes                                | Outcome                                                                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A brings X to front, B sends Y to back            | Both happen.                                                                                                                                                |
| A and B each bring a different element to front   | Both end in front of all others, in an order decided by key and id, the same on every replica.                                                              |
| A and B move the same element to different places | One key wins, the same on every replica; no duplicate.                                                                                                      |
| A reorders X, B reparents X                       | X ends in the new parent; if A's key wins, X is at an arbitrary but deterministic place among the new siblings. Accepted: rare and easy to fix.             |
| Equal keys                                        | Allowed. Siblings with equal keys are sorted by id. An operation that must place an element between two siblings with equal keys places it just after them. |

## 5. Containers, structure and concurrent edits

### 5.1 The effective tree

After a merge, an element may point at a parent that does not exist (not yet delivered, or purged), at something that is not a container, or into a cycle (A moved frame F into G while B moved G into F). Every replica turns the stored state into the same _effective tree_ with a pure function (`Resolver` in `model/resolve.ts`), without writing anything:

1. A parent that does not exist or is not a frame or group counts as the root.
2. Each parent cycle is broken at its member with the smallest id, which counts as being at the root.

The rules depend only on the state, so all replicas see the same tree. Operations never "repair" the stored parent: a move writes only the position, so if a parent record simply has not arrived yet (peer-to-peer delivery), nothing is lost when it arrives (section 5.3, rule 3, then places the element correctly).

### 5.2 Frames

A frame (`core/frame`) is a named, visible rectangle that contains elements. It has `pos` and `size` but no rotation, because a frame can be a stop and the camera does not rotate. Its `data` has `clip` (draw children only inside the frame), `fill` and `stroke` (CSS colors or null). Elements inside a frame follow it when it moves, and z-order applies within it.

### 5.3 Positions, rebases and moving between containers

Containers have a translation-only local space: a child's position in its container's parent is the container's local position plus the child's.

**The problem.** If moving an element and moving it into another container both wrote its position, a concurrent move and reparent would write the same key and one change would be lost, depending on Yjs's client ids. And a position read in the wrong space makes the element jump.

**Two keys, written by different operations.**

- `pos` is `{x, y, space}`; `space` is the element's effective parent when the position was written. Only moving an element (and creating it) writes `pos`. A move never writes `parent` or `rebase`.
- `rebase` is `{to, base, shifts}` or null. Changing an element's container (reparent, grouping, moving out of a gone container) writes `parent`, a new `rebase` leading `to` the new parent, `order`, and never `pos`:
  - `shifts` holds, for each space a position may have been written in, the translation into the new parent: for the space of the stored position, for the element's current parent, and for every space of the previous rebase if that rebase was still in effect (it led to the current parent). A concurrent move, written in whatever container its author saw the element in, is therefore covered, also across chains of reparents.
  - `base`, when the stored position is already in the new parent's space (an element returning to a container), holds that exact position and its shift. A later move writes a different position, to which `base` no longer applies; `pos` is never rewritten.

A drag that ends in another container is a reparent followed by a move, in one command: the move writes a position in the new parent's space, to which the rebase no longer applies.

**Resolution** (`Resolver.localPosition`), with P the effective parent:

1. If `rebase.to` is P: a position in P's space is used as stored, shifted by `base` if it is exactly the base position; a position in another space is shifted by the matching entry of `shifts`.
2. Otherwise, a position in P's space is used as stored.
3. Otherwise (only after conflicting concurrent container changes, a broken cycle, or a parent that arrived late): the position is converted from its space into P with container offsets computed by rules 1 and 2 alone, through the lowest common ancestor. If the space does not exist, is not a container, or lies inside the element, x and y are used as they are. Using rules 1 and 2 for the offsets keeps the computation free of cycles and independent of evaluation order.

A shift is a fixed translation recorded at the time of the reparent, so the element follows its new parent and is unaffected when its old container moves later. At most 64 shifts are kept. Stale rebases (a move happened since) are harmless and are cleared by tidy up.

### 5.4 Groups

A group (`core/group`) is an invisible container. It has a position (the origin of its local space) but no size: its bounds are the union of its visible descendants' bounds. An empty group is not drawn and has no bounds. Groups can be nested and can contain frames, and frames can contain groups.

Grouping (`ops.group`) requires the elements to be visible in the same container (the same logical parent; some may sit inside gone containers there). It creates the group in that container, in front of the frontmost member's slot, with its origin at the top-left of the members' bounds, then moves the members into it as in section 5.3. Members keep their order keys. The group is created dissolved in an untracked transaction and restored in the local one, so undoing a grouping dissolves the group (section 10).

Moving a group writes only the group's `pos`. Scaling or rotating a group is a command that rewrites the members' positions, sizes and rotations.

### 5.5 Removal: observed-remove delete, and dissolve

Elements, stops and routes are never removed from their maps by normal editing.

**Revisions.** Every operation that changes a record writes a fresh random `rev` into it: moves, resizes, renames, locking, data and ext changes, reordering, reparenting, and any edit of shared types inside the record (the command layer MUST list every element and stop it changes, `edit(..., { touch })`). Removing and restoring do not change `rev`.

**Delete.** Deleting element R writes a delete mark `{action, root: R, rev}` on R and on every descendant this replica sees (except ones already deleted), each with its own current `rev` and the same random `action`. An element is _deleted_ (`Resolver.isDeleted`) when:

1. it carries a mark whose `rev` equals its current `rev` (nobody changed it since the deleting user saw it), and
2. the mark's action is still in effect: the root R exists, carries a mark with the same action whose `rev` equals R's current `rev`, and R is not dissolved.

Consequences, which together implement the rule _when one user deletes something and another concurrently works on something inside it, the other user's work survives_:

- An element added to a deleted container concurrently (or moved into it) has no mark: it survives.
- An element inside a deleted container that someone changed concurrently has a newer `rev`: it survives.
- A deleted element that someone changed concurrently survives itself (its `rev` changed), and so does everything its delete covered (the action is no longer in effect).
- Restoring R (clearing its mark) restores everything the delete covered. A later delete is a new action, so old marks on descendants never come back to life.

**Dissolve.** Ungroup and "remove frame, keep contents" set `dissolved` on the container. Its children are not touched. A dissolved container is never deleted (rule 2), so a dissolve beats a concurrent delete of the same container whatever the client ids.

**Gone containers are transparent.** Deleted and dissolved elements are _gone_ (`Resolver.isGone`): not drawn, not selectable. A gone container keeps its position and its slot, so its visible children stay exactly where they are on the canvas and in the stacking order; the user sees them in the nearest container that is not gone (`Resolver.logicalParentOf`). So a survivor of a deleted frame stays where it was, now in the frame's parent.

Stops and routes have a simpler mark: `removed: {rev}`. A stop or route is removed while the mark's `rev` equals its current `rev`, so a concurrent change of it cancels the removal (`isRemoved` in `model/route.ts`). Adding a visit to a stop is a change of both the route and the stop.

Why soft removal at all: in Yjs, removing a map entry while someone edits inside it discards their edits, and undo cannot bring them back.

### 5.6 Locking

`locked` is an editor rule: a locked element, or one inside a locked container the user sees (not gone), cannot be selected by clicking and refuses edits through commands until unlocked (`Resolver.isLocked`). The model and the reference operations do not enforce it, so a change made concurrently with a lock is kept.

### 5.7 Outcomes of concurrent structural edits

These are the intended outcomes; each row has a test that runs it with the client ids in both orders (section 15).

| A does                                                    | B does, concurrently            | Outcome after merge                                                                                     |
| --------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| moves X into frame F                                      | moves X (within its old parent) | X is in F, at B's position on the canvas.                                                               |
| moves X back into the frame its position was written in   | moves X                         | X is in the frame, at B's position.                                                                     |
| groups Y, then moves Y in the group                       | moves Y into frame G            | Y is in G at A's position, and does not follow the old group later.                                     |
| moves X into G, then out again                            | moves X                         | X is where B put it, and follows neither G nor its first frame later.                                   |
| moves X out of frame F to the root                        | moves F                         | X is at the root where A put it; F moves without X.                                                     |
| moves frame F into frame G                                | moves G into F                  | Cycle: broken at the smaller id, which goes to the root; the other stays inside it. Nothing disappears. |
| moves X into F1                                           | moves X into F2                 | X ends in one of them, the same on both replicas, at its place on the canvas.                           |
| groups X and Y                                            | groups Y and Z                  | Two groups; Y is in exactly one. Nothing lost or duplicated.                                            |
| groups X and Y                                            | moves X                         | X is in the group, at B's position.                                                                     |
| ungroups G                                                | adds Z to G                     | G's children, Z included, stay visible and in place.                                                    |
| ungroups G                                                | moves G                         | The children end where B's move put them.                                                               |
| ungroups G                                                | deletes G                       | Dissolve wins: the children stay.                                                                       |
| deletes frame F                                           | moves X out of F                | X survives where B put it.                                                                              |
| deletes frame F                                           | moves X into F                  | X survives where it is, in F's parent. Restoring F puts X back in F.                                    |
| deletes frame F                                           | edits X inside F                | X survives, in F's parent; F and the rest of its contents are deleted.                                  |
| deletes frame F                                           | (nobody touches it)             | F and everything in it are deleted; restoring F restores them.                                          |
| deletes X                                                 | edits X                         | The edit wins: X stays, with B's edit.                                                                  |
| A moves X into G; B deletes G; C moves X (three replicas) |                                 | X survives at C's position, in every delivery order.                                                    |
| locks X                                                   | moves X                         | X is locked and moved.                                                                                  |

### 5.8 Tidy up and exports for sharing

Removed records stay in the document so that offline copies, however old, can still merge (no purge by age). They are purged only:

- by the explicit **tidy up** command (`tidyUp` in `ydoc/document-ops.ts`), which cannot be undone; an offline copy that later merges loses its edits to purged records;
- in every **export for sharing** (`writeGalatsaFile(..., { forSharing: true })`): the snapshot is purged and no `ydoc.bin` is written, so nothing deleted travels with a shared file.

Purging (`purgeSnapshot` in `model/purge.ts`) keeps what the user sees unchanged: it removes gone elements, removed stops and routes, route entries and visibility entries pointing at them, unknown references in `refs`, and asset descriptions nothing refers to; it moves surviving children of gone containers into their logical parent at the same place on the canvas and with order keys that keep the stacking order; it turns frame stops whose frame is gone into rectangle stops showing the same region; and it normalizes positions (no rebases) and clears stale marks.

## 6. Stops and routes

### 6.1 Stops

A stop is what one press of "next" shows:

| Key              | Type   | Meaning                                                                                         |
| ---------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `name`           | string | Name shown in the route strip.                                                                  |
| `view`           | JSON   | The region to show (section 6.2).                                                               |
| `notes`          | Y.Text | Speaker notes.                                                                                  |
| `visibility`     | Y.Map  | Element id -> `{action: "show" \| "hide"}`, applied on arrival (section 6.4).                   |
| `transition`     | JSON   | Transition into this stop, defined by the transition extension; null means the route's default. |
| `rev`, `removed` |        | Section 5.5.                                                                                    |
| `ext`            | map    | Open slots (section 9.4).                                                                       |

### 6.2 What a stop shows

A stop stores a region, not a camera pose. The player fits the region to the screen (keeping the aspect ratio, centring it), so the same stop works on any screen shape, and a different camera model (for example 3D) can show the same stops.

- `{kind: "frame", frame, padding}`: the frame's rectangle, with a margin of `padding` times its larger side. The stop follows the frame. If the frame is gone, its record (and geometry) is still there and the stop still works; if the record is missing entirely, the stop is skipped.
- `{kind: "rect", space, x, y, w, h}`: a rectangle in the local space of the container `space` (null for the root). The editor SHOULD use the innermost frame that contains the whole rectangle. If `space` is missing or not a container, the rectangle is read in root space.

`stopRegion` returns the region in the most local space available, which is where the camera anchors. A transition between two stops is computed in the space of the lowest common ancestor of the two regions' spaces (`Resolver.offset`), so a flight between neighbouring stops deep inside nested frames never goes through large numbers.

### 6.3 Routes and shared stops

A route has `name`, `order` (its place in the list of routes), `rev`, `removed`, `ext`, and `entries`: a `Y.Map` from entry id to `{stop, order}`. Playing a route walks its entries sorted by order key and id (`routeSteps`), skipping entries whose stop is missing or removed.

A shared stop is a stop that entries in more than one route point at; editing it changes it in every route. A stop can appear more than once in one route. To change a stop for one route only, the editor copies it and points that route's entry at the copy.

Removing a stop skips its entries everywhere until it is restored. Removing an entry deletes the entry's key (an entry is only a reference). Entries are ordered by keys rather than kept in a `Y.Array` so that two users moving the same entry give one result instead of a duplicate.

### 6.4 What a stop shows and hides

Each stop may show or hide elements on arrival. Along a route, the changes add up (`hiddenAt`):

1. An element whose first change in the route is "show" starts hidden (an entrance). Any other element mentioned in the route starts visible. Elements no stop in the route mentions are always visible.
2. Arriving at each step applies that stop's changes.
3. Hiding a container hides what the user sees inside it (`isHiddenBy`); a gone container hides nothing, so a change set on a group that was later ungrouped no longer affects its former members.

So "show at stop 3, hide at stop 5" means hidden at stops 1 and 2, visible at 3 and 4, hidden from 5 on. In a route that skips stop 3, the element is visible from the start until stop 5 (decided with the users). Jumping to a stop computes the state from the start of the route. When the presenter roams freely, the state of the last stop stays. In the editor, everything is visible. Several builds at one view are consecutive stops with the same view.

### 6.5 Outcomes of concurrent stop and route edits

| A does                                   | B does, concurrently                | Outcome                                                                |
| ---------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| edits shared stop S's name (via route 1) | edits S's notes (via route 2)       | Both kept; both routes show both.                                      |
| sets S to show X                         | sets S to hide Y                    | Both kept.                                                             |
| sets S to show X                         | sets S to hide X                    | One wins, the same on both replicas.                                   |
| changes S's view                         | changes S's view                    | One wins whole.                                                        |
| removes S                                | edits S                             | The edit wins: S stays.                                                |
| removes S                                | adds S to a route                   | S stays (it was used).                                                 |
| removes S                                | (nobody touches it)                 | S is skipped in every route until restored.                            |
| inserts S1 into route R                  | inserts S2 into R at the same place | Both entries kept, in a deterministic order.                           |
| moves entry E                            | moves entry E elsewhere             | E ends at one place; no duplicate.                                     |
| removes entry E                          | moves entry E                       | E stays (a concurrent write beats a delete of the same key). Accepted. |

## 7. Coordinates, zoom range and numeric precision

### 7.1 Units

One world unit is one CSS pixel at zoom 1. The y axis points down. Zoom is screen pixels per world unit. All model and camera arithmetic uses float64. Stored numbers MUST be finite.

### 7.2 The problem

A float64 has 53 significant bits. A coordinate of magnitude m can only take values about m * 2^-52 apart, so at zoom z it can only be placed to within about m * z * 2^-52 pixels. With one global coordinate system, zooming to 10^9 a million units from the origin leaves less than a pixel. Drawing backends are worse: canvas implementations and GPUs often use float32 for transforms.

### 7.3 The decision

1. **Parent-local coordinates** (section 5.3). Content inside a frame is stored relative to the frame, so its numbers stay small however far the frame is from the world origin. Geometry inside `data` (freehand points, map features) SHOULD be relative to the element's box.
2. **Lowest-common-ancestor arithmetic.** Every conversion between spaces (`Resolver.offset`, `positionIn`, `boundsIn`), in resolution and in every operation (reparent, grouping, restacking out of gone containers, purging, copying), sums local positions from both spaces up to their lowest common ancestor, smallest numbers first, and never goes through world coordinates. Moving an element between two frames inside a frame at x = 2^60 keeps a local position of 3e-7 exact (tested).
3. **Anchored camera.** The camera (`CameraView` in `model/geometry.ts`) is a centre and a zoom in the local space of a container (or the root). The renderer SHOULD anchor it in the innermost frame that contains the view and re-anchor as the view moves. Stops store regions in the same way.
4. **Camera-relative rendering.** The renderer computes each element's position relative to the camera's anchor with `Resolver.offset`, multiplies by the zoom, and passes only the resulting small screen coordinates to the drawing backend. Text is laid out at its on-screen size.

**Zoom range.** `MIN_ZOOM` = 2^-32 and `MAX_ZOOM` = 2^32 (a ratio of about 1.8 * 10^19). A web map spans about 2^20.

**Precision budget.** The error on screen is about |c| * z * 2^-52 pixels, where c is the camera centre in its anchor space. Keeping |c| * z <= 2^46 (`PRECISION_BUDGET`) keeps it at or below 1/64 pixel. The camera clamps zoom to `min(MAX_ZOOM, 2^46 / max(|cx|, |cy|, 1))` (`maxPreciseZoom`), so precision runs out as a zoom limit, never as jitter.

Practical meaning: the full zoom range is available near the origin of every frame, however far that frame is from the world origin (each frame starts a fresh budget, and frames nest); at the root, it is limited only far from the origin. Zoom is absolute (frames have no scale), so `MAX_ZOOM` is the deepest zoom anywhere. A first renderer MAY anchor the camera at the root only; anchoring in frames needs no change to the document.

## 8. Assets

### 8.1 Identity

An asset is a binary file the document uses (an image, a video, a font). Its id is `sha256-` followed by the lowercase hex SHA-256 of its bytes, so the same file added many times, by any number of users, is one asset. SHA-256 is available through Web Crypto in browsers, the desktop web view and Node.

### 8.2 In the document

The `assets` root map holds, per asset id, an `AssetInfo`: `mediaType`, `byteLength`, and optionally `name`, `width`, `height` and `external` (section 8.4). The bytes are not in the Y.Doc. They live in an asset store: the file's `assets/` folder, a file next to the presentation, the app's local cache, or, later, the sync server. Derived versions (downscaled images, posters) are a cache, never part of the document.

### 8.3 References and which assets a file carries

An asset is referenced wherever its id appears as a complete string value: in element `data` and `ext`, in stops (transition, notes embeds, `ext`), in routes' `ext`, and in settings (`referencedAssets` in `model/walk.ts`); text of rich text runs does not count. Nothing else needs to be declared, so assets used by elements of unknown types, by transitions or by the background are never forgotten.

A normal save writes the bytes of every referenced asset, removed records included, so restoring something after reopening finds its image. Tidy up and exports for sharing purge first (section 5.8), so assets only removed content used are left out. An asset whose bytes are missing is a normal state: the element shows a "missing asset" placeholder, and the reader warns only for assets that visible content uses.

On reading, each asset's bytes MUST be hashed and compared with its id; a mismatch means damage, the asset is treated as missing and the user is told.

### 8.4 Very large media

Media is embedded in the file by default. For very large files the user can choose to keep the media in a file next to the presentation: its `AssetInfo` then has `external: {path}`, a plain file name (no folders, drive letters, `.` or `..`) relative to the presentation file's folder, and the writer does not embed the bytes. The app looks for the file there and verifies its hash. When the presentation is moved without the file, the asset is missing (section 8.3).

## 9. File format

### 9.1 The archive

A Galatsa file (extension `.galatsa`) is a zip archive:

```
mimetype                 "application/vnd.galatsa.presentation+zip", first entry, stored
manifest.json            versions and merge identity (9.2)
document.json            the document in JSON form (9.3)
ydoc.bin                 optional: the Yjs state (9.3)
assets/sha256-<hex>      one entry per embedded asset, the raw bytes
thumbnail.png            optional: preview, longest side at most 512 pixels
```

- `mimetype` comes first and is stored, so tools that look at the first bytes can recognize the file.
- Text and the Yjs state are deflated. Already compressed media and the thumbnail are stored.
- Entry names are printable ASCII. Readers MUST reject absolute names, names with `..`, `.`, backslashes or empty segments, duplicate names, local headers whose name differs from the central directory, and entries that share bytes. Readers ignore entries they do not know without decompressing them; writers do not carry them over.
- **Size.** Version 1 writers do not use zip64, which limits a file to 4 GiB (files with very large media can keep it external, section 8.4). Zip64 can be added later without breaking anything: a writer uses it only for files that need it and then sets `minReaderVersion` to the version that reads zip64; version 1 readers refuse such files with "needs a newer version of Galatsa" (they detect zip64 before reading the manifest). Files below 4 GiB stay readable by every version.

### 9.2 manifest.json

```json
{
  "format": "galatsa",
  "formatVersion": 1,
  "minReaderVersion": 1,
  "generator": "Galatsa 0.1.0",
  "ydoc": { "encoding": "yjs-update-v1", "lineage": "<lineage id>" },
  "thumbnail": { "mediaType": "image/png" }
}
```

- `format` MUST be `"galatsa"`. `formatVersion` and `minReaderVersion` are integers with 1 <= `minReaderVersion` <= `formatVersion`, equal to the document's `schemaVersion` and `minReaderVersion` (section 9.4).
- `generator` is for diagnosis; readers MUST NOT change behaviour on it.
- `ydoc` is present exactly when `ydoc.bin` is: its encoding (`Y.encodeStateAsUpdate`, update format v1) and the lineage of the Y.Doc it holds. A reader MUST NOT decode `ydoc.bin` unless `ydoc` is present with an encoding it knows.
- `thumbnail` is present when `thumbnail.png` is.

### 9.3 document.json, ydoc.bin and merge identity

`document.json` is the canonical content: a `DocumentSnapshot` as UTF-8 JSON, removed records included (section 5.5). It is enough to open the file. Writers SHOULD write object keys in a deterministic order; readers MUST NOT depend on key order. `readGalatsaSnapshot` (entry `@galatsa/format/read`) reads only this, so the player needs no Yjs.

`ydoc.bin` only preserves CRDT identity: a document reopened from it can still merge with other copies (another user's offline edits, the sync server's state).

**Lineage.** A Y.Doc's `meta.lineage` is a random id created with the document's CRDT identity: by `initDocument`, and anew whenever identity is reset: `fromSnapshot` (opening a file without a usable `ydoc.bin`, a viewer export, a migrated file). Two Y.Docs built from the same `document.json` have different lineages. Sync MUST refuse to exchange updates between documents with different lineages (`syncDocs` throws `MergeIdentityError`); merging them would compare unrelated CRDT histories and silently drop one user's edits. The lineage is not part of the JSON form.

**Reading `ydoc.bin`.** The reader uses `ydoc.bin` only if all hold; otherwise it builds a new document from `document.json` (with a new lineage) and reports that merge identity was lost:

1. the manifest describes it (`ydoc.encoding` known, `ydoc.lineage` given), no migration ran, and it is no larger than a limit (default 256 MiB);
2. it decodes, and the decoded `meta.lineage` equals the manifest's;
3. it has no hidden content (`hiddenContent`: unknown root types, unknown keys in meta, element, stop or route maps, non-JSON settings or asset descriptions);
4. its JSON form equals `document.json` exactly, apart from `schemaVersion` and `minReaderVersion`, which a compatible upgrade may raise (the reader then writes them into `meta`).

### 9.4 Versions, open slots and migrations

**Two numbers.** `schemaVersion` (in the document, and `formatVersion` in the manifest) is the version of the content: the highest format version that wrote it. `minReaderVersion` is the oldest reader that can read it correctly. Both are 1 in this specification.

- **Additive changes** need no new reader. They go into open slots that every reader keeps losslessly: element, stop and route `ext` maps (`"<owner>.<name>"` -> value, any value of section 3.4), and `settings`. Examples: alt text, opacity, links, per-element presentation hints. A writer that adds such content may raise `schemaVersion` but leaves `minReaderVersion`. A reader whose version is at least `minReaderVersion` opens the file, keeps every slot it does not understand, and writes the file back with the same versions (tested: a version 1 reader keeps version 3 additions).
- **Incompatible changes** (a new envelope key, a changed meaning, a required new entry, zip64) raise `minReaderVersion`. A reader whose version is lower MUST refuse the file with a message that it needs a newer Galatsa. Opening read-only was rejected: the reader cannot know what it would misdraw.
- Validation is strict outside the open slots: unknown fields are errors, because a compatible writer never puts them there.

**Migrations.** A file whose `formatVersion` is lower than the reader's is upgraded on load. Only steps that change content have a migration (`from` -> `from + 1`); other steps just raise the version numbers. A migration is a pure, deterministic function on the parsed manifest and document (plain JSON, before validation) and leaves element data it does not own alone. If any migration ran, `ydoc.bin` is discarded and the document gets a new lineage; if only numbers were raised, merge identity is kept. Migrations are registered in `packages/format` and never removed.

**Policy for keeping merge identity** (decided now, before any extension ships):

1. Format changes are made additive wherever possible, so they never reset merge identity.
2. Readers do not migrate element data on load. An extension MUST read every older `typeVersion` of its own data, and a live document may mix `typeVersion`s of one type. An extension upgrades an element's data only as part of a user's edit of that element, in the same local transaction (so it merges like any edit, and is attributed and undoable). Extensions SHOULD design upgrades so that two users upgrading concurrently converge (add keys rather than rewrite them).
3. An element whose `typeVersion` is higher than its extension knows is treated as an element of a missing extension (section 9.5) and never down-migrated.
4. An incompatible format change that cannot avoid a migration resets merge identity; old copies are then refused by sync rather than merged wrongly. Migrating live shared documents is an open question (section 13).

### 9.5 Elements from missing extensions

When the reader does not have the extension for an element's type (or has an older version of it):

- **Kept:** the element is loaded as is; its `data` and `ext` are converted with the generic encoding of section 3.4 and written back unchanged. Its assets are kept, because references are found by scanning.
- **Drawn:** as a placeholder: a box with the element's position, size and rotation, labelled with a localized "Missing extension" and the type id.
- **Editable** only through the envelope: move, z-order, into and out of frames and groups, lock, delete, duplicate and paste (references in `refs` remapped as in section 3.5). Resizing, rotating and editing the content are disabled, because the extension may tie the box to the content (decided with the users).
- **Tested:** a round trip through a file leaves the element's JSON form byte for byte equal, with and without `ydoc.bin`.

### 9.6 Validation and damaged files

The reader validates `document.json` structurally (`validateSnapshot`): types, shapes and allowed keys of every envelope, stop, route and asset description, order key syntax, ids, well-formed tagged values, and a nesting depth of at most 256 (checked without recursion, so hostile input cannot overflow the stack). It does not check references: dangling parents, frames, stops and assets are legal and handled by resolution. A broken archive, a missing or invalid manifest or document, or invalid JSON is reported as damaged with a message naming the problem; any other error while reading is reported as damaged too, never thrown as such. Recovering the last good version after an interrupted save is the job of the saving code (write a temporary file, then replace).

### 9.7 Limits

Readers bound memory and work before decompressing anything: a total declared uncompressed size of the entries they use (default 4 GiB) and a number of entries (default 100 000), from the central directory; entries may not share bytes, so declared sizes add up to real memory. Each entry is inflated in 16 KiB chunks into a buffer of exactly its declared size and inflating stops as soon as the output would exceed it, so an entry that lies about its size costs no more than it declared; the result must then match the declared size and CRC-32. Unknown entries are not decompressed. `ydoc.bin` is untrusted input too: it is decoded only within its size limit and accepted only under the conditions of section 9.3.

### 9.8 The zip library

Requirements: a license compatible with GPL-3.0-or-later, no dependencies, works in browsers, the desktop web view and Node without platform APIs, and small, because the player reads files and exported presentations embed the player.

| Candidate                                                     | License                 | Size                                             | Notes                                                |
| ------------------------------------------------------------- | ----------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| [fflate](https://www.npmjs.com/package/fflate) 0.8.3          | MIT                     | 797 kB unpacked; tree-shakes to what is imported | No dependencies. Sync, async and streaming APIs.     |
| [JSZip](https://www.npmjs.com/package/jszip) 3.10.2           | MIT or GPL-3.0-or-later | 693 kB unpacked                                  | Four dependencies; larger in a bundle.               |
| [zip.js](https://www.npmjs.com/package/@zip.js/zip.js) 2.25.0 | BSD-3-Clause            | 8.7 MB unpacked                                  | Streaming, zip64, encryption; much more than needed. |

Licenses and sizes are from the npm registry, checked 2026-11-26.

Choice: **fflate for compression, own code for the archive structure.** The writer uses fflate's `zipSync`. The reader parses the zip directory itself and uses fflate's streaming `Inflate`, because the checks of sections 9.1 and 9.7 need control fflate's unzip does not give.

Measured bundle sizes (Vite 8 production build, minified, then gzip; measured 2026-11-26 with a throwaway script, not part of the repository):

| What                                                                 | Minified | Gzip    |
| -------------------------------------------------------------------- | -------- | ------- |
| zip reader (`readZip`)                                               | 11.1 kB  | 4.4 kB  |
| zip writer (`writeZip`)                                              | 13.2 kB  | 5.3 kB  |
| `@galatsa/core` model (no Yjs)                                       | 36.2 kB  | 10.1 kB |
| `@galatsa/format/read` + resolution and routes (what a player needs) | 39.3 kB  | 12.2 kB |
| `@galatsa/core/ydoc` (includes Yjs and lib0)                         | 158 kB   | 40.9 kB |
| `readGalatsaFile` (reads into a Y.Doc)                               | 155 kB   | 41.3 kB |

## 10. Undo

Undo and redo are built (in the command layer) on Yjs's `UndoManager`, configured by `createUndoManager` (`ydoc/schema.ts`): it tracks only transactions whose origin is the local user (`ORIGIN.local`), so loading, record creation, tidy up and remote changes are never undone.

Undo MUST never hard-delete a record, because that would discard other users' concurrent work inside it. So every record is created in two transactions: first, untracked (`ORIGIN.create`), already removed (an element with a delete mark, a group dissolved, a stop or route with a removal mark); then, in the local transaction, restored. Undoing a creation re-applies the removal; redoing clears it. Consequences (tested):

- Undoing a grouping dissolves the group; a member another user added meanwhile stays in place.
- Undoing a creation while another user typed into the element: their change gave it a new revision, so it survives with their text (section 5.5).

Soft removal is also what makes undo of a delete restore concurrent edits: undo clears the mark instead of re-creating a deleted map. Route entries are references and are deleted by undo of an insertion; asset descriptions are added untracked.

## 11. Where the code lives, and dependencies

- `packages/core/src/model`: everything that does not need Yjs: the JSON-form types, order keys, resolution, stops and routes, validation, purging, fragments, reference scanning, zoom range. Exported from `@galatsa/core`.
- `packages/core/src/ydoc`: the Yjs binding: root layout and undo configuration, the generic data encoding, `toSnapshot`/`fromSnapshot`, `hiddenContent`, lineage, reference operations, tidy up and paste, sync helpers. Exported from `@galatsa/core/ydoc`. Test helpers (a seeded random source and a sample document) are a separate entry, `@galatsa/core/testing`, not part of the production entries.
- `packages/format`: reading and writing files, asset hashing, migrations. `@galatsa/format` has everything; `@galatsa/format/read` reads into the JSON form without Yjs.

The Yjs binding is in core because the document model _is_ a Y.Doc; it is a separate entry so the player can use the types and resolution without Yjs. Core stays environment-agnostic: no DOM or Node types; it uses only `globalThis.crypto.getRandomValues`.

**Known performance issue.** The reference operations build a `Resolver` over the whole document for each operation (O(n log n) per drag step). Fine for thousands of elements; the command layer should keep one incrementally updated resolver per document (observing Yjs events) before documents get large.

New production dependencies (licenses compatible with GPL-3.0-or-later; versions at least two weeks old on 2026-11-26):

| Package                                                                  | Version | Published  | License | Why                                             |
| ------------------------------------------------------------------------ | ------- | ---------- | ------- | ----------------------------------------------- |
| [yjs](https://www.npmjs.com/package/yjs)                                 | 13.6.33 | 2026-09-23 | MIT     | The CRDT the plan chose for the document model. |
| [lib0](https://www.npmjs.com/package/lib0) (via yjs)                     | 0.2.120 | 2026-11-09 | MIT     | Yjs's utility library.                          |
| [isomorphic.js](https://www.npmjs.com/package/isomorphic.js) (via lib0)  | 0.2.5   | 2022       | MIT     | Random numbers and crypto across platforms.     |
| [fractional-indexing](https://www.npmjs.com/package/fractional-indexing) | 4.0.0   | 2026-06-25 | CC0-1.0 | Order key generation (section 4).               |
| [fflate](https://www.npmjs.com/package/fflate)                           | 0.8.3   | 2026-05-16 | MIT     | Deflate and zip writing (section 9.8).          |

## 12. Assumptions

1. Yjs's update format v1 stays readable by future Yjs versions. If not, `document.json` still opens every file; only merge identity is lost.
2. Yjs resolves concurrent writes to the same map key the same way on every replica, and a concurrent set beats a delete of the same key. The tests check the outcomes that depend on it.
3. No more than a few hundred thousand elements per document.
4. Containers never need rotation or scale.
5. A file is read whole into memory; streaming is future work.
6. Users who want unbounded deep zoom do it inside frames.
7. The command layer touches (`rev`) every record it changes, including edits of shared types inside data. An extension edit that forgets this is treated as "not worked on" by a concurrent delete.
8. Random revisions and actions never collide (128 bits).

## 13. Open questions and known limitations

1. **Live migrations.** In phase 4, a shared document on the server may need an incompatible migration while clients are connected. Running it once on the server, raising `minReaderVersion` and resetting the lineage (old clients must reload) is likely, but undecided.
2. **Key growth.** Order keys grow when many items are inserted at one spot (about 130 characters after 1000 insertions between the same neighbours). Rebalancing (re-keying a container's children in one transaction) would conflict with concurrent reorders; tidy up could do it. Not needed yet.
3. **Replacing shared types.** Setting a data key to a new shared type discards concurrent edits inside the old one, and Yjs's undo restores the old value without edits made after it was replaced. Extensions should create their shared types with the element (section 3.4, pattern 8).
4. **`__proto__` inside plain data.** Yjs's own encoding of plain values (lib0) drops object keys named `__proto__` nested inside plain JSON when updates travel between replicas. Galatsa handles them locally and in files, and keys of data maps, ext maps and shared maps (including `__proto__`) are safe, but nested plain-JSON keys of that name do not survive sync. Validation could reject them; not done yet.
5. **Media type.** `application/vnd.galatsa.presentation+zip` is not registered with IANA.
6. **Visibility effects.** `VisibilityChange` has only `action`. Fade and similar effects would be optional keys (a minimum-reader question, since `visibility` values are not open slots) or belong to the transition extension; for the extension interface work.
7. **Repair writes.** Resolution never writes; stale state (rebases, cycle breakers, gone containers with children) stays until tidy up. Whether the editor should normalize earlier is open; writing positions outside a move would reintroduce the conflict of section 5.3.
8. **Mixed double conflicts.** Rule 3 of section 5.3 uses container offsets from rules 1 and 2; if a container is itself in a rule-3 state (two overlapping conflicting container changes), positions inside it are approximate (not lost, possibly slightly off). The fuzz test finds no failure of the invariants, but does not measure this.
9. **Edit-wins delete for stops in routes.** Inserting an entry counts as working on the stop and keeps it; reordering entries does not. Whether reordering a route should also keep a concurrently removed stop is a product question.

## 14. Rejected alternatives

- **A `Y.Array` of child ids per container.** Concurrent moves duplicate or lose elements.
- **Absolute (world) positions.** Moving a frame would rewrite every child; concurrent additions would be left behind; precision is wasted.
- **Reparent rewrites `pos`.** The first version of this design. A concurrent move and reparent then write the same key and one is lost depending on client ids. The rebase keeps both.
- **One rebase translation from the stored position's space only.** Also tried first: a move written in the space of a pending rebase (after grouping) fell back to rule 3 and the element then followed its old group. Recording a shift for every space the element was in fixes it, including chains.
- **Rewriting `pos` when an element returns to the space its position was written in.** Lost a concurrent move for one client order; `base` replaces it.
- **One atomic placement value (parent, order, position).** A concurrent move and reparent would lose one change entirely.
- **Hard delete.** Loses concurrent edits; undo cannot restore them.
- **Delete wins (first version).** A deleted container hid everything in it, including what others added or edited concurrently. The users decided that concurrent work survives (section 5.5).
- **Delete marks without revisions.** Would keep elements added to a deleted container, but not elements edited inside it, and the outcome of delete vs dissolve would depend on client ids.
- **Ungroup by moving the children out.** Loses children added concurrently and a concurrent move of the group.
- **Purging removed records by age.** Long-offline copies could no longer merge (decided with the users: purge only on request and in exports for sharing).
- **Absolute per-stop visibility.** Tedious and inconsistent across stops.
- **Stops as camera poses.** Ties stops to screen shape and the 2D camera.
- **A single global coordinate space.** Limits deep zoom to roughly 2^46 / |position|.
- **Scale factors on frames.** Complicates every conversion and stop fitting; float64's exponent range covers tiny local coordinates.
- **Arbitrary-precision coordinates.** Slow everywhere for a benefit only at extreme zoom.
- **The Y.Doc as the only content of a file.** Every reader would need Yjs; migrations would operate on CRDT internals.
- **JSON only, no `ydoc.bin`.** Reopening would always lose merge identity.
- **Merge identity from the document id alone.** Two documents built from the same JSON share the id but not the CRDT history; merging them silently drops edits (demonstrated). Hence the lineage.
- **A single version number.** Any additive change would lock out every older reader.
- **An explicit asset list in the envelope** (first version). Missed assets referenced from stops and settings. Scanning for asset ids finds them all.
- **Dropping assets of deleted elements on save** (first version). Restoring after reopening showed a missing asset; purging handles size instead.
- **fflate's `unzipSync` and `inflateSync` for reading.** No checksum verification, no overlap check, and a lying entry is inflated in full before its size can be checked.
- **Throwing on values JSON cannot express.** One value from a peer made a whole document unsaveable.
- **Migrating element data on load.** Every extension upgrade would cut a file off from other users' offline copies.

## 15. Tests

All tests run with `pnpm check` (Vitest). Concurrency tests use replicas that start from the same state, change independently, then exchange updates (`Y.encodeStateAsUpdate` against the other's state vector), and check that all replicas end with equal JSON forms and the outcome specified above, with the client ids in both orders.

- `packages/core/src/ydoc/merge-elements.test.ts`: for each element type (frame, group, text, shape, image, freehand, table, chart, map, media), two concurrent edits of different parts both survive, and a same-key conflict converges.
- `packages/core/src/ydoc/merge-structure.test.ts`: the rows of the tables in sections 4.3, 5.7 and 6.5.
- `packages/core/src/ydoc/regressions.test.ts`: the defects found in review: rebase chains and returns, lineage refusal, totality and lossless round trip of every odd value (embedded shared types, binary, undefined, node attributes, hooks, `__proto__` ids and keys, a peer injecting values), undo of grouping and of creation with concurrent work, precision of operations far from the origin, operations on children of gone containers, moves with late-arriving parents, tidy up, paste with reference remapping, hidden content.
- `packages/core/src/ydoc/fuzz.test.ts`: three replicas apply 60 random operations each run (move, reparent, group, dissolve, delete, restore, restack, rename, undo, redo) with random partial syncs, then sync fully; checks convergence, validity, lossless round trip, a sane drawing order, finite positions, no failing operation, and that purging changes nothing visible. 30 seeds by default; `GALATSA_FUZZ_SEEDS=150` for the full run.
- `packages/core/src/ydoc/encode.test.ts`: the generic encoding round-trips every shared type, the escape and any trees.
- `packages/core/src/model/model.test.ts`: order keys and their syntax, ids, zoom clamp, resolution (orphans, cycles, the three position rules, delete marks and revisions, dissolve, group bounds), routes and show/hide, stop regions, validation (unknown fields, order keys, ids, nesting depth, external media).
- `packages/format/src/zip.test.ts`: CRC-32, order, deterministic output, unsafe and duplicate names, truncation, corruption, size limits, zip64 refusal, overlapping entries, lying sizes stopped early, local/central name mismatch, skipped unknown entries.
- `packages/format/src/file.test.ts`: round trip with equal document and bytes; archive and manifest layout; unknown extensions with and without `ydoc.bin`; merge identity across a reopened file; assets kept while soft-deleted and dropped in exports for sharing; migrations (with a test registry, since version 1 is the first); compatible newer files keep their additions; too-new files are refused; damage codes; asset hashes; `ydoc.bin` rejected when it disagrees, carries hidden content, is not described by the manifest, has another lineage or is too large; deleted content absent from sharing exports; assets referenced from settings, transitions and embeds; deep nesting reported, not crashed.
