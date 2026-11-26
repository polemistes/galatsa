# 0001 Document model and file format

- Status: proposed, awaiting review
- Date: 2026-11-26
- Code: `packages/core/src/model` (types, order keys, resolution, stops and routes, validation, zoom range), `packages/core/src/ydoc` (the Yjs binding, exported as `@galatsa/core/ydoc`), `packages/format` (the file format)

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
13. Open questions
14. Rejected alternatives
15. Tests

The key words MUST, SHOULD and MAY are used in their usual sense (RFC 2119).

## 1. Context and summary

Galatsa is a presentation program built around an infinite canvas. The presenter places elements on the canvas, moves a camera over it, and saves routes of camera stops. A canvas can have several routes, and routes can share stops. The program works fully offline and without an account. Real-time collaboration (Yjs over WebSocket), offline editing that merges later, and viewers that receive snapshots come later, but the document model has to allow all of them from the start, because changing the stored model later means migrating every user's files.

Element types (text, shapes, images, freehand drawing, tables, charts, maps, media) are provided by extensions. A file may contain elements from an extension the reading program does not have; those must survive loading and saving untouched.

The decisions, in short:

| Topic                    | Decision                                                                                                                                                                                                        | Section |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Storage                  | One Yjs `Y.Doc` per document. Flat maps of elements, stops, routes and assets keyed by random ids.                                                                                                              | 2       |
| Element structure        | A fixed envelope that core understands (type, parent, order, position, size, rotation, name, lock, asset references, removal) plus type-specific `data` that only the extension understands.                    | 3       |
| Z-order                  | A fractional order key per element, among its siblings. No arrays of children.                                                                                                                                  | 4       |
| Frames and groups        | Containers with a translation-only local coordinate space. An element stores its parent; positions are local to the parent and tagged with the space they were written in.                                      | 5       |
| Concurrency of structure | Every replica resolves the merged state with the same pure function: orphans go to the root, parent cycles are broken deterministically, stale positions are converted.                                         | 5       |
| Deletion                 | Soft. A deleted element keeps its record, so concurrent edits are not lost and undo can restore everything. Ungroup and "remove frame, keep contents" dissolve the container instead of moving the children.    | 5.5     |
| Stops                    | A stop shows a region (a frame, or a rectangle in some container's space), not a camera pose. It holds notes, a transition, and show/hide changes.                                                              | 6       |
| Routes                   | A route is a list of entries, each pointing at a stop, ordered by fractional keys. Shared stops are simply stops that more than one route points at.                                                            | 6.3     |
| Visibility               | Show/hide changes add up along the route. An element first shown at a stop is hidden before it.                                                                                                                 | 6.4     |
| Precision                | float64 throughout; parent-local coordinates; the camera and stop regions are anchored in a container's space; rendering is camera-relative. Zoom 2^-32 to 2^32, clamped further where precision would run out. | 7       |
| Assets                   | Identified by the SHA-256 of their bytes. The document holds descriptions; bytes are stored beside it.                                                                                                          | 8       |
| File                     | A zip archive: `mimetype`, `manifest.json` (with the format version), `document.json` (canonical, plain JSON), optional `ydoc.bin` (Yjs state, to keep merge identity), `assets/`, `thumbnail.png`.             | 9       |
| Old files                | Numbered format versions; a chain of pure JSON migrations upgrades old files on load. Newer files are refused with a clear message.                                                                             | 9.4     |
| Missing extensions       | The element's envelope is used (position, size, z-order, grouping), its data is kept as opaque JSON and written back unchanged, and a placeholder is drawn.                                                     | 9.5     |

## 2. The document and its layout in Yjs

A document is one `Y.Doc` with six root maps. Everything that two people may change at the same time is a separate key or a separate shared type, so that unrelated changes never overwrite each other.

```
Y.Doc
├─ "meta"      Y.Map    schemaVersion: number, id: string, title: string
├─ "settings"  Y.Map    "<owner>.<name>" -> JSON
├─ "elements"  Y.Map    ElementId -> Y.Map (an element, section 3)
├─ "stops"     Y.Map    StopId -> Y.Map (a stop, section 6)
├─ "routes"    Y.Map    RouteId -> Y.Map (a route, section 6)
└─ "assets"    Y.Map    AssetId -> AssetInfo (JSON, section 8)

element Y.Map
  type, typeVersion, parent, order, pos, size, rot, name, locked, assets, removed
                       JSON values; last writer wins per key
  data                 Y.Map: per key, a JSON value or a nested shared type
                       (Y.Text, Y.Map, Y.Array, Y.XmlFragment)

stop Y.Map
  name, view, transition, removed      JSON values
  notes                                Y.Text
  visibility                           Y.Map: ElementId -> { action: "show" | "hide" }

route Y.Map
  name, order, removed                 JSON values
  entries                              Y.Map: RouteEntryId -> { stop, order } (JSON)
```

Rules that follow from the layout:

- **Granularity.** In a `Y.Map`, concurrent writes to the same key are resolved by Yjs: one value wins, the same one on every replica. Concurrent writes to different keys are all kept. Values that must change together are stored as one JSON value under one key (for example `pos` holds x, y and the space together; a whole stop `view` is one value), so a merge never mixes half of one user's change with half of another's.
- **No arrays of ids for structure.** Membership (which container an element is in) is the element's own `parent` key, and order is its own `order` key. A container does not list its children. This avoids the duplicates and losses that `Y.Array` gives when two users move the same item at the same time (section 14).
- **Typed `meta`.** `schemaVersion` is the version of this layout (equal to the file format version, section 9.4). `id` is the document's id: copies that are meant to merge share it; "save as a new presentation" gives a new one.
- **Settings.** Document-wide settings, such as the background color or the default transition, are plain JSON under keys named `<owner>.<name>`, for example `core.background` or `galatsa.transitions.default`.
- **The JSON form.** `DocumentSnapshot` in `packages/core/src/model/types.ts` is the same structure as plain JSON. `toSnapshot` and `fromSnapshot` in `@galatsa/core/ydoc` convert both ways. The JSON form is what files store (section 9.3) and what viewers receive.

## 3. Elements

### 3.1 Ids

Element, stop, route and route entry ids, and document ids, are opaque strings of 1 to 64 characters from `A-Z a-z 0-9 _ -`. New ids are 128 random bits written as 22 URL-safe base64 characters (`newId` in `model/ids.ts`), from the platform's secure random source, so replicas never need to coordinate. Readers MUST NOT give any meaning to an id's content. There are no reserved ids: the canvas root is `null`, not an id.

### 3.2 Element types

An element's `type` is `"<extension id>/<type name>"`, both parts from `a-z 0-9 . _ -` starting with a letter or digit, for example `galatsa.text/text`. The type never changes after the element is created. Two types are defined by core:

- `core/frame`: a frame (section 5.2).
- `core/group`: a group (section 5.4).

`typeVersion` (an integer from 1) is the version of the layout of the element's `data`, owned by the extension. It lets an extension change its data layout without a file format change (section 9.4).

### 3.3 The envelope

Every element has these keys. Core and every extension understand them; they are what lets an element of an unknown type still be placed, stacked, grouped and drawn as a placeholder.

| Key           | Type                             | Meaning                                                                                                           |
| ------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `type`        | string                           | Element type id.                                                                                                  |
| `typeVersion` | integer >= 1                     | Version of `data`'s layout.                                                                                       |
| `parent`      | id or null                       | The frame or group the element is in; null for the canvas root.                                                   |
| `order`       | string                           | Fractional order key among siblings (section 4).                                                                  |
| `pos`         | `{x, y, space}`                  | Top-left corner of the unrotated box, in the local space of the container `space` (section 5.3).                  |
| `size`        | `{w, h}`                         | Width and height in world units, >= 0. Not on groups.                                                             |
| `rot`         | number                           | Rotation in radians about the box centre, clockwise on screen. Only on extension elements (not frames or groups). |
| `name`        | string                           | User-visible name; empty when unnamed.                                                                            |
| `locked`      | boolean                          | Locked elements cannot be selected or changed in the editor (section 5.6).                                        |
| `assets`      | asset ids                        | Every asset `data` refers to (section 8).                                                                         |
| `removed`     | null, `"delete"` or `"dissolve"` | Soft removal (section 5.5).                                                                                       |
| `data`        | map                              | Type-specific data (section 3.4).                                                                                 |

The envelope is closed: a new envelope key is a format change (section 9.4). Extensions put everything else in `data`.

### 3.4 Type-specific data

`data` is a `Y.Map`. Each value is either a plain JSON value (replaced as a whole when written) or a shared type that merges item by item: `Y.Text` (rich text with formatting attributes, as a delta), `Y.Map`, `Y.Array`, or `Y.XmlFragment` (with `Y.XmlElement` and `Y.XmlText`) for editors that need a tree. Shared types can nest inside `Y.Map` and `Y.Array`, but not inside plain JSON.

In the JSON form, a shared type is an object with a `"$y"` tag:

| Yjs type        | JSON form                                                                   |
| --------------- | --------------------------------------------------------------------------- |
| `Y.Text`        | `{"$y": "text", "delta": [{"insert": "Hi", "attributes": {"bold": true}}]}` |
| `Y.Map`         | `{"$y": "map", "entries": {"key": <value>}}`                                |
| `Y.Array`       | `{"$y": "array", "items": [<value>, ...]}`                                  |
| `Y.XmlFragment` | `{"$y": "xmlFragment", "children": [<node>, ...]}`                          |
| `Y.XmlElement`  | `{"$y": "xmlElement", "name": "p", "attributes": {...}, "children": [...]}` |
| `Y.XmlText`     | `{"$y": "xmlText", "delta": [...]}`                                         |

Only a value that sits directly in a data map, a shared map or a shared array is read as a tagged type. A plain JSON object in such a position that happens to have a `"$y"` key of its own is escaped as `{"$y": "json", "value": {...}}`. Anything nested inside plain JSON is plain JSON. Text embeds MUST be plain JSON objects. Binary values (`Uint8Array`) are not allowed in the document; binary content is an asset.

This encoding needs no knowledge of the element type, so `toSnapshot` and `fromSnapshot` convert elements of unknown types losslessly (section 9.5).

**Patterns for extension authors.** These follow from how Yjs merges, and the tests use them for every planned type:

1. Properties that change independently get separate keys (fill and stroke of a shape): concurrent changes to different properties are both kept.
2. Values that only make sense together are one JSON value (a crop rectangle, a media trim range, a map projection with its parameters): a merge never mixes halves.
3. Text that people edit is a `Y.Text`: concurrent typing merges character by character.
4. Collections whose items are added, removed and reordered concurrently are a `Y.Map` keyed by random item ids, each item with a fractional `order` key, like elements and route entries (table rows and columns, chart series, map features). `Y.Array` is only for append-mostly sequences that are not reordered (freehand strokes): concurrent moves in a `Y.Array` duplicate items.
5. Derived data (text layout, rendered bitmaps, downscaled images) is never stored in the document.
6. Large binary content is an asset.

**Provisional layouts of the planned types.** The extensions define their own layouts in the extension interface work; these are the layouts the merge tests use, and the starting point for that work.

| Type     | `data`                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text     | `text`: Y.Text (paragraph attributes such as alignment and lists on the newline, as in Quill deltas); `fontFamily`, `fontSize`, `color`: JSON           |
| shape    | `kind` (template id), `fill`, `stroke`, `strokeWidth`, `cornerRadius`, `opacity`: JSON                                                                  |
| image    | `crop`: JSON `{x, y, w, h}`; `opacity`: JSON; the asset id in `asset` and in the envelope's `assets`                                                    |
| freehand | `strokes`: Y.Array of JSON `{points: number[], color, width}`; `smoothing`: JSON                                                                        |
| table    | `rows`, `cols`: Y.Map id -> JSON `{order, size}`; `cells`: Y.Map `"<row>:<col>"` -> Y.Text                                                              |
| chart    | `kind`, `options`: JSON; `categories`: Y.Map id -> JSON `{label, order}`; `series`: Y.Map id -> Y.Map `{name, order, values: Y.Map category -> number}` |
| map      | `view`: JSON (projection, centre, scale); `features`: Y.Map id -> Y.Map `{kind, geometry (JSON), style (JSON), label (Y.Text)}`                         |
| media    | `asset`, `trim` (`{start, end}`), `autoplay`, `loop`, `volume`: JSON                                                                                    |

## 4. Z-order

### 4.1 Order keys

Each element has an `order` key: a string that sorts siblings (elements with the same effective parent, section 5.1) from back to front. Keys are compared as plain strings by UTF-16 code unit (never by locale). Ties are broken by element id, compared the same way. Higher sorts in front.

New keys are generated with the `fractional-indexing` algorithm (`generateKeyBetween`), so a key can always be made between two others without touching any other element. Generated keys get three random digits appended (when the result still sorts strictly between its neighbours), so two replicas that insert at the same place at the same time almost never produce equal keys. The comparison rule is the only part that is fixed by the format: a reader that only displays never generates keys.

The same mechanism orders route entries within a route and routes in the list of routes.

### 4.2 Stacking rules

- Z-order applies among siblings. A container's subtree is drawn in the container's slot: everything inside a frame is in front of the frame's own background and behind everything that is in front of the frame. "Bring to front" inside a frame brings the element to the front of that frame.
- Drawing order is a depth-first walk from the root, siblings back to front (`Resolver.drawOrder`). Deleted subtrees are skipped. A dissolved container is not drawn, but its children are, in its slot.
- Operations (`ops.ts`): bring to front (key after the frontmost live sibling), send to back (key before the backmost), one step forward (key between the next sibling in front and the one after it), one step backward (the mirror). Each writes only the moved element's `order`.

### 4.3 Concurrent reorders

| Concurrent changes                                | Outcome                                                                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A brings X to front, B sends Y to back            | Both happen.                                                                                                                                                         |
| A and B each bring a different element to front   | Both end in front of all others; their relative order is decided by key (jitter) and then id, the same on every replica.                                             |
| A and B move the same element to different places | One key wins (Yjs's rule for the same map key), the same on every replica.                                                                                           |
| A reorders X, B reparents X                       | X ends in the new parent; its key, if A's wins, puts it at an arbitrary but deterministic place among the new siblings. Accepted: rare and easy to fix.              |
| Equal keys from writers without jitter            | Allowed. Siblings are sorted by id within the tie. An operation that must place an element between two siblings with equal keys places it just after them (`keyAt`). |

## 5. Containers, structure and concurrent edits

### 5.1 The effective tree

The stored `parent` keys form a tree only as long as nobody edits concurrently. After a merge, an element may point at a parent that was never synced (purged), at something that is not a container, or into a cycle (A moved frame F into G while B moved G into F). Every replica turns the stored state into the same _effective tree_ with a pure function (`Resolver` in `model/resolve.ts`), without writing anything:

1. A parent that does not exist or is not a frame or group counts as the root.
2. Each parent cycle is broken at its member with the smallest id (code unit order), which counts as being at the root. The rest of the cycle hangs below it.

Because the rules depend only on the state and not on the order in which a replica processes it, all replicas see the same tree. Removed containers stay in the tree (their records are kept), which is what lets their children keep their place.

An editor MAY write a repair later (for example, set the stored parent of a cycle breaker to null on its next local change of that element), but MUST NOT need to.

### 5.2 Frames

A frame (`core/frame`) is a named, visible rectangle that contains elements. It has `pos` and `size` but no rotation, because a frame can be a stop and the camera does not rotate. Its `data` has `clip` (draw children only inside the frame), `fill` and `stroke` (CSS colors or null); more appearance keys can be added by core later. Elements inside a frame follow it when it moves, and z-order applies within it.

### 5.3 Local coordinates and tagged positions

Containers have a translation-only local space: the world position of a child is the container's world origin plus the child's local position. There is no scale and no rotation in a container's space, so conversions are additions only and exact enough to be done anywhere.

Each position is stored as `{x, y, space}`, where `space` is the container the position is relative to. Writers set `space` to the element's parent at the time of writing. Normally `space` equals `parent`. It differs only after a merge in which one user moved the element (writing `pos`) while another moved it to a different container (writing `parent`, `pos` and `order`). Without the tag, the moved position would be read in the wrong space and the element would jump by the offset between the two containers.

Resolution (`Resolver.localPosition`):

- If `space` equals the effective parent, `x, y` are the local position.
- Otherwise, if `space` is a container that exists and is not the element itself or inside it, the position is converted through world coordinates: `world = rawOrigin(space) + (x, y)`, `local = world - rawOrigin(parent)`. `rawOrigin` adds up the stored `x, y` of a container and its effective ancestors without looking at their tags. Using raw origins keeps the computation free of cycles and independent of evaluation order; it is exact unless an ancestor's position is itself stale, which needs two overlapping concurrent conflicts.
- Otherwise `x, y` are used as local coordinates.

The next local move of the element writes a fresh position with the current parent, which removes the stale tag.

### 5.4 Groups

A group (`core/group`) is an invisible container. It has a position (the origin of its local space) but no size: its bounds are the union of its live children's bounds (`Resolver.bounds`). An empty group is not drawn and has no bounds. Groups can be nested and can contain frames, and frames can contain groups.

Grouping (`ops.group`) requires the elements to share a parent. It creates the group in that parent with the frontmost member's order key (so the group takes that member's slot), puts the group's origin at the top-left of the members' bounds, and rewrites each member's `parent` and `pos` (now relative to the group). Members keep their order keys, so their stacking among each other is unchanged.

Moving a group writes only the group's `pos`. Scaling or rotating a group is a command that rewrites the members' positions, sizes and rotations; groups themselves have no scale or rotation.

### 5.5 Removal: delete and dissolve

Elements, stops and routes are never removed from their maps by normal editing. Removing sets `removed`, and restoring clears it.

- **Delete** (`removed: "delete"`): the element and its whole effective subtree are hidden (`Resolver.isDeleted`). Only the deleted element itself is marked; its descendants are hidden through it, so restoring the one mark restores everything.
- **Dissolve** (`removed: "dissolve"`, containers only): the container disappears, its children stay. They keep their stored parent and position; resolution treats the dissolved container as transparent: it still carries its position (so the children stay where they are on the canvas) and its slot in the z-order, but it is not drawn, cannot be selected, and does not lock its children. The user sees the children as belonging to the nearest container that is not dissolved (`Resolver.logicalParentOf`). Ungroup and "remove frame, keep contents" are dissolves.

Why soft removal: in Yjs, removing a map entry while someone else edits inside it discards the other person's edits, and Yjs's own undo cannot bring them back. With soft removal, edits made concurrently with a delete are kept inside the removed record, and undoing the delete shows them. Why dissolve: moving the children out of the container at ungroup time would lose children that another user adds to the group concurrently (they would end up in a removed group) and would lose a concurrent move of the group. Dissolving touches nothing but the container.

Cost: removed records stay in the document and in files. A compaction step that purges old removed records is an open question (section 13). Assets referenced only by removed elements are not written to files (section 8.3).

### 5.6 Locking

`locked` is an editor rule, not a model rule: a locked element (or one inside a locked container that is not dissolved, `Resolver.isLocked`) cannot be selected by clicking and refuses edits through commands until it is unlocked. The model and the reference operations do not enforce it, so a change made concurrently with a lock is kept.

### 5.7 Outcomes of concurrent structural edits

These are the intended outcomes. Each has a test (section 15).

| A does                             | B does, concurrently            | Outcome after merge                                                                                                                  |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| moves X into frame F               | moves X (within its old parent) | X is in F, at B's position on the canvas (converted through the tag).                                                                |
| moves X out of frame F to the root | moves F                         | X is at the root where A put it; F moves without X.                                                                                  |
| moves frame F into frame G         | moves G into F                  | Cycle: broken at the smaller id, which goes to the root; the other stays inside it. Nothing disappears. Both replicas show the same. |
| moves X into F1                    | moves X into F2                 | X ends in one of them, the same on both replicas; its position is consistent with that parent (a stale tag is converted).            |
| groups X and Y                     | groups Y and Z                  | Two groups; Y is in exactly one of them. Nothing is lost or duplicated.                                                              |
| ungroups G                         | adds Z to G                     | All of G's children, Z included, stay visible and in place.                                                                          |
| ungroups G                         | moves G                         | The children end where B's move put them.                                                                                            |
| deletes frame F                    | moves X out of F                | X survives at the root (or wherever B put it).                                                                                       |
| deletes frame F                    | adds X to F                     | X is hidden with F; restoring F shows X.                                                                                             |
| deletes X                          | edits X (text, data, position)  | X is deleted; B's edit is kept in the record and visible again if X is restored.                                                     |
| locks X                            | moves X                         | X is locked and moved.                                                                                                               |

## 6. Stops and routes

### 6.1 Stops

A stop is what one press of "next" shows. It has:

| Key          | Type    | Meaning                                                                                         |
| ------------ | ------- | ----------------------------------------------------------------------------------------------- |
| `name`       | string  | Name shown in the route strip.                                                                  |
| `view`       | JSON    | The region to show (section 6.2).                                                               |
| `notes`      | Y.Text  | Speaker notes; merge character by character.                                                    |
| `visibility` | Y.Map   | Element id -> `{action: "show" \| "hide"}`, applied on arrival (section 6.4).                   |
| `transition` | JSON    | Transition into this stop, defined by the transition extension; null means the route's default. |
| `removed`    | boolean | Soft removal.                                                                                   |

### 6.2 What a stop shows

A stop stores a region, not a camera pose. The player fits the region to the screen (keeping the aspect ratio, centring it), so the same stop works on any screen shape, and a different camera model (for example a 3D one) can show the same stops.

- `{kind: "frame", frame, padding}`: the frame's rectangle, with a margin of `padding` times the frame's larger side. The stop follows the frame when it moves or is resized. If the frame is removed, its record (and so its geometry) is still there and the stop still works. If the frame record is missing entirely, the stop is skipped (and the editor shows it as broken).
- `{kind: "rect", space, x, y, w, h}`: a rectangle in the local space of the container `space` (null for the root). The editor SHOULD use the innermost frame that contains the whole rectangle, so the stop moves with that frame and stays precise at deep zoom (section 7.3). If `space` is missing or not a container, the rectangle is read in root space.

`stopRegion` in `model/route.ts` returns the region in the most local space available (the frame's parent space for frame stops), which is where the camera anchors.

### 6.3 Routes and shared stops

A route has a `name`, an `order` key (its place in the list of routes), `removed`, and `entries`: a `Y.Map` from entry id to `{stop, order}`. Playing a route walks its entries sorted by order key and id (`routeSteps`), skipping entries whose stop is missing or removed.

A shared stop is a stop that entries in more than one route point at. Editing it (name, view, notes, visibility, transition) changes it in every route. The same stop can also appear more than once in one route (for example, returning to an overview). To change a stop for one route only, the editor copies it into a new stop and points that route's entry at the copy.

Removing a stop sets its `removed` flag; entries that point at it are skipped until it is restored, so undo brings the stop back into every route. Removing an entry from a route deletes the entry's key (an entry is only a reference; nothing is lost). Removing a route sets its `removed` flag.

Entries are ordered by keys rather than kept in a `Y.Array` so that moving an entry is one write of its `order`, and two users moving the same entry give one result instead of a duplicate.

### 6.4 What a stop shows and hides

Each stop may show or hide elements on arrival. Along a route, the changes add up (`hiddenAt`):

1. An element whose first change in the route is "show" starts hidden (an entrance). Any other element mentioned in the route starts visible. Elements no stop in the route mentions are always visible.
2. Arriving at each step applies that stop's changes.
3. Hiding a container hides its subtree.

So "show at stop 3, hide at stop 5" means hidden at stops 1 and 2, visible at 3 and 4, hidden from 5 on. Because the state depends on the route, a shared stop behaves sensibly in each route: in a route that skips stop 3, an element shown there and hidden at stop 5 is visible until stop 5. Jumping to a stop computes the state from the start of the route. When the presenter leaves the route to roam freely, the state of the last stop stays. In the editor, everything is visible.

Several builds at the same view (as with PowerPoint animations) are consecutive stops with the same view and different changes.

### 6.5 Outcomes of concurrent stop and route edits

| A does                                   | B does, concurrently                      | Outcome                                                                         |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| edits shared stop S's name (via route 1) | edits S's notes (via route 2)             | Both kept; both routes show both.                                               |
| sets S to show X                         | sets S to hide Y                          | Both kept.                                                                      |
| sets S to show X                         | sets S to hide X                          | One wins, the same on both replicas.                                            |
| changes S's view                         | changes S's view                          | One wins (the view is one value).                                               |
| removes S                                | edits S                                   | S is removed; B's edit is kept and visible after restore.                       |
| removes S                                | adds S to route 2                         | S is removed; route 2's new entry is skipped until S is restored.               |
| inserts S1 into route R                  | inserts S2 into route R at the same place | Both entries kept, in a deterministic order.                                    |
| moves entry E                            | moves entry E elsewhere                   | E ends at one place; no duplicate.                                              |
| removes entry E                          | moves entry E                             | E stays (Yjs keeps a concurrent write over a delete of the same key). Accepted. |

## 7. Coordinates, zoom range and numeric precision

### 7.1 Units

One world unit is one CSS pixel at zoom 1. The y axis points down. Zoom is screen pixels per world unit. All model and camera arithmetic uses JavaScript numbers (IEEE 754 float64). Stored numbers MUST be finite.

### 7.2 The problem

A float64 has 53 significant bits. A coordinate of magnitude m can only take values about m * 2^-52 apart, so at zoom z it can only be placed to within about m * z * 2^-52 screen pixels. With a single global coordinate system, zooming to 10^9 at a point a million units from the origin leaves less than one usable pixel of precision. Drawing backends are worse: canvas 2D implementations and GPUs often use float32 (24 bits) for transforms, so passing world coordinates to them breaks long before float64 does.

### 7.3 The decision

Three measures, which together make precision depend on where the camera is relative to nearby content, not on where content sits in the world:

1. **Parent-local coordinates** (section 5.3). Content inside a frame is stored relative to the frame, so its numbers stay small and precise however far the frame is from the world origin. Element geometry inside `data` (freehand points, map features) SHOULD be relative to the element's box.
2. **Anchored camera.** The camera (`CameraView` in `model/geometry.ts`) is a centre and a zoom in the local space of a container (or the root). The renderer SHOULD anchor it in the innermost frame that contains the view, and re-anchor as the view moves. Stops store regions in the same way (section 6.2), so flying to a stop deep inside nested frames never goes through large world numbers.
3. **Camera-relative rendering.** The renderer computes each element's position relative to the camera's anchor in float64 (`element origin - anchor origin - camera centre`, summed along the shortest path through the tree), multiplies by the zoom, and passes only the resulting small screen coordinates to the drawing backend. World coordinates never reach canvas, DOM transforms or the GPU. Text is laid out at its on-screen font size, not scaled from world units.

**Zoom range.** `MIN_ZOOM` = 2^-32 and `MAX_ZOOM` = 2^32, a ratio of 2^64 (about 1.8 * 10^19). For comparison, a web map goes from the whole earth to a single building in about 2^20.

**Precision budget.** The error on screen is about |c| * z * 2^-52 pixels, where c is the camera centre in its anchor space. Keeping |c| * z <= 2^46 (`PRECISION_BUDGET`) keeps it at or below 1/64 pixel. The camera clamps zoom to `min(MAX_ZOOM, 2^46 / max(|cx|, |cy|, 1))` (`maxPreciseZoom`), so where precision runs out the user meets a zoom limit, never jitter. Examples: at the root with the camera within 16 384 units of the origin, the full 2^32 is available; a million units out, about 7 * 10^7; inside a frame, the same budget applies to the camera's position relative to that frame.

Practical meaning: deep zoom works without limit inside frames (each frame starts a fresh budget); at the root, it is limited only far from the origin. Users who build "a world inside a dot" do it with frames, which is also how stops find it.

**Phase 1 latitude.** A first renderer MAY anchor the camera at the root only, relying on the clamp. Anchoring in frames can be added later without any change to the document, because stops already carry their space.

### 7.4 Why not something else

See section 14: a single global space (with or without camera-relative rendering), scale factors on frames, and arbitrary-precision numbers were considered.

## 8. Assets

### 8.1 Identity

An asset is a binary file the document uses (an image, a video, a font). Its id is `sha256-` followed by the lowercase hex SHA-256 of its bytes. The same file added ten times, by any number of users, is one asset with one id, and two replicas that add it concurrently write the same key with the same value. SHA-256 is available through Web Crypto in every browser, in the desktop app's web view, and in Node.

### 8.2 In the document

The `assets` root map holds, per asset id, an `AssetInfo`: `mediaType`, `byteLength`, and optionally `name` (original file name, for display), `width` and `height`. The bytes are not in the Y.Doc (they would make every sync and every save carry them, and Yjs is not built for large binary values). They live in an asset store: the file's `assets/` folder (section 9), the app's local cache, or, later, the sync server.

Elements refer to assets from their `data`, and MUST also list every asset they refer to in the envelope's `assets`. This is what lets core keep the assets of elements whose extension is missing.

Derived versions (downscaled images, video posters) are a cache, never part of the document. They are identified by the source asset id plus the variant and can always be recomputed.

### 8.3 Which assets are written to a file

A file contains the bytes of every asset listed by an element that is not deleted (not removed with "delete" and not inside a deleted container). Assets listed only by deleted elements are left out, so deleting a large video makes the file smaller. Their descriptions stay in `assets`; if such an element is restored, it shows a "missing asset" placeholder until the bytes are found again (for example in the app's local cache). An asset whose bytes are missing is a normal state, not an error.

On reading, each asset's bytes MUST be hashed and compared with its id. A mismatch means damage; the asset is treated as missing and the user is told.

## 9. File format

### 9.1 The archive

A Galatsa file (extension `.galatsa`) is a zip archive:

```
mimetype                       "application/vnd.galatsa.presentation+zip", first entry, stored uncompressed
manifest.json                  format and version (9.2)
document.json                  the document in JSON form (9.3)
ydoc.bin                       optional: the Yjs state (9.3)
assets/sha256-<hex>            one entry per asset, the raw bytes, no extension
thumbnail.png                  optional: preview image, longest side at most 512 pixels
```

- `mimetype` comes first and is stored, so tools that look at the first bytes can recognize the file (the same convention as OpenDocument and EPUB).
- Text and the Yjs state are deflated. Assets whose media type is already compressed (PNG, JPEG, WebP, GIF, video, audio, zip-based formats) and the thumbnail are stored, so saving does not spend time recompressing them.
- Entry names are ASCII. Readers MUST reject names that are absolute, contain `..`, backslashes or empty segments, and duplicate names, and MUST ignore entries they do not know (writers do not carry them over).
- Version 1 does not use zip64, so an archive is limited to 4 GiB. Readers reject zip64 archives with a clear message. See section 13.

### 9.2 manifest.json

```json
{
  "format": "galatsa",
  "formatVersion": 1,
  "generator": "Galatsa 0.1.0",
  "ydoc": { "encoding": "yjs-update-v1" },
  "thumbnail": { "mediaType": "image/png" }
}
```

- `format` MUST be `"galatsa"`.
- `formatVersion` is an integer (section 9.4).
- `generator` names the program that wrote the file, for diagnosis. Readers MUST NOT change behaviour on it.
- `ydoc` is present when `ydoc.bin` is, and says how it is encoded (`Y.encodeStateAsUpdate`, update format v1).
- `thumbnail` is present when `thumbnail.png` is.

### 9.3 document.json and ydoc.bin

`document.json` is the canonical content: a `DocumentSnapshot` as UTF-8 JSON, keys sorted, including removed records (section 5.5). It is enough to open the file. The player reads only this, so it does not need Yjs.

`ydoc.bin` is optional and only preserves CRDT identity: a document reopened from it can still merge with other copies of the same document (another user's offline edits, or the sync server's state) without duplicating everything. A document rebuilt from `document.json` alone has fresh identity and merges only with copies made after that.

On reading, if `ydoc.bin` is present, the reader decodes it and compares its JSON form with `document.json`. If they are equal, the decoded Y.Doc is used. If not (the JSON was edited by another tool, or a migration ran, or `ydoc.bin` is damaged), `document.json` wins, a fresh Y.Doc is built from it, and the reader reports that merge identity was lost. Writers MAY leave `ydoc.bin` out (exports for viewers do).

### 9.4 Versions and migrations

There is one version number, `formatVersion`, which is also the document's `schemaVersion`. It is 1 for this specification. It is raised for any change that an older reader would lose or misread: a new envelope key, a changed meaning, a new required entry. Changes inside an extension's `data` are versioned by the element's `typeVersion` instead, and do not change the format version.

- A file with a higher `formatVersion` than the reader knows MUST be refused, with a message that it was made by a newer Galatsa. (Opening read-only was considered and rejected: the reader cannot know what it would misdraw.)
- A file with a lower version is upgraded on load by a chain of migrations, one per version step (`from` -> `from + 1`). A migration is a pure, deterministic function on the parsed `manifest.json` and `document.json` (plain JSON, before validation), so it can handle elements of unknown types by leaving their `data` alone. After migrating, `ydoc.bin` is discarded (the reader reports lost merge identity) and the document is validated as the current version. Saving writes the current version.
- Migrations are registered in `packages/format` and never removed, so any old file can be opened.
- Element data migrations (`typeVersion`) belong to the extension. On load, an element whose `typeVersion` is lower than its extension's is migrated by the extension on the JSON form before the Y.Doc is built (the reader takes a hook for this); an element whose `typeVersion` is higher than its extension knows is treated as an element of a missing extension (section 9.5) and never down-migrated. If any element is migrated, `ydoc.bin` is discarded, as for format migrations.
- Migrating live shared documents (phase 4) is an open question (section 13).

### 9.5 Elements from missing extensions

When the reader does not have the extension that provides an element's type (or has an older version of it, section 9.4):

- **Kept:** the element is loaded as is. Its `data` is converted with the generic encoding of section 3.4, which needs no knowledge of the type, and written back unchanged. Its assets are kept, because the envelope lists them.
- **Drawn:** as a placeholder: a box with the element's position, size and rotation, labelled with a localized "Missing extension" and the type id.
- **Editable:** only through the envelope: move, z-order, put in or take out of frames and groups, lock, delete, duplicate (copying `data` as is). Resizing, rotating and editing the content are disabled, because the extension might have rules tying the box to the content.
- **Tested:** a round trip through a file leaves the element's JSON form byte for byte equal.

### 9.6 Validation and damaged files

The reader validates `document.json` structurally (`validateSnapshot` in `model/validate.ts`): types and shapes of every envelope, stop, route and asset description, and well-formed tagged data. It does not check references: dangling parents, frames, stops and assets are legal and handled by resolution. A file that fails validation, has a broken archive (truncated, a bad CRC), lacks `manifest.json` or `document.json`, or has invalid JSON is reported as damaged with a message naming the problem; nothing is loaded. Recovering the last good version after an interrupted save is the job of the saving code (write to a temporary file, then replace), not of the format.

### 9.7 Limits

Readers SHOULD refuse archives whose entries declare more than a configured total uncompressed size (default 4 GiB) or a compression ratio that suggests a zip bomb, before decompressing them. Entry sizes are checked against the archive's central directory and the actual inflated size.

### 9.8 The zip library

Requirements: a free license compatible with GPL-3.0-or-later, no dependencies, works in browsers, the desktop web view and Node without platform APIs, and small, because the player will read files (and exported presentations embed the player).

| Candidate                                                     | License                 | Size                                                                   | Notes                                                                                     |
| ------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [fflate](https://www.npmjs.com/package/fflate) 0.8.3          | MIT                     | 797 kB unpacked; tree-shakes to only what is imported (measured below) | No dependencies. Sync and async APIs, zip and raw deflate/inflate.                        |
| [JSZip](https://www.npmjs.com/package/jszip) 3.10.2           | MIT or GPL-3.0-or-later | 693 kB unpacked                                                        | Four dependencies (`pako`, `readable-stream`, `lie`, `setimmediate`); larger in a bundle. |
| [zip.js](https://www.npmjs.com/package/@zip.js/zip.js) 2.25.0 | BSD-3-Clause            | 8.7 MB unpacked                                                        | Streaming, zip64, encryption; much more than needed.                                      |
| Own code                                                      | GPL-3.0-or-later        | small                                                                  | Zip's container (directory records, CRC-32) is simple; deflate is not.                    |

Licenses and sizes are from the npm registry (`npm view <name> license dist.unpackedSize`), checked 2026-11-26.

Choice: **fflate for compression, own code for the archive structure.** The writer uses fflate's `zipSync`. The reader parses the zip directory itself (about 150 lines) and uses fflate's `inflateSync` only, because fflate's unzip does not verify CRC-32 checksums or let the reader check declared sizes before inflating, both of which a damaged-file message and the limits in 9.7 need. A player that only reads needs our parser plus fflate's inflate, which keeps it small.

## 10. Undo

Undo and redo are built (in the command layer) on Yjs's `UndoManager`, tracking only transactions whose origin is the local user (`ORIGIN.local` in `ydoc/schema.ts`). Loading, migrations and remote changes use other origins and are never undone. Soft removal (section 5.5) is what makes undo of a delete restore concurrent edits: undo flips `removed` back instead of re-creating a deleted map.

## 11. Where the code lives, and dependencies

- `packages/core/src/model`: everything that does not need Yjs: the JSON-form types, order keys, resolution, stops and routes, validation, zoom range. Exported from `@galatsa/core`.
- `packages/core/src/ydoc`: the Yjs binding: root layout, the generic data encoding, `toSnapshot`/`fromSnapshot`, and reference operations. Exported from `@galatsa/core/ydoc`.
- `packages/format`: reading and writing files, asset hashing, migrations.

The Yjs binding is in core, not a separate package, because the document model _is_ a Y.Doc: the editor, renderer, command layer and file format all work on it, and a separate package would only add a hop. It is a separate entry point so that the player can import the types and resolution from `@galatsa/core` without loading Yjs. Core stays environment-agnostic: no DOM or Node types; it uses only `globalThis.crypto.getRandomValues`, which browsers and Node both provide.

New production dependencies (all licenses compatible with GPL-3.0-or-later; versions at least two weeks old on 2026-11-26):

| Package                                                                  | Version | Published  | License | Why                                             |
| ------------------------------------------------------------------------ | ------- | ---------- | ------- | ----------------------------------------------- |
| [yjs](https://www.npmjs.com/package/yjs)                                 | 13.6.33 | 2026-09-23 | MIT     | The CRDT the plan chose for the document model. |
| [lib0](https://www.npmjs.com/package/lib0) (via yjs)                     | 0.2.120 | 2026-11-09 | MIT     | Yjs's utility library.                          |
| [isomorphic.js](https://www.npmjs.com/package/isomorphic.js) (via lib0)  | 0.2.5   | 2022       | MIT     | Random numbers and crypto across platforms.     |
| [fractional-indexing](https://www.npmjs.com/package/fractional-indexing) | 4.0.0   | 2026-06-25 | CC0-1.0 | Order key generation (section 4).               |
| [fflate](https://www.npmjs.com/package/fflate)                           | 0.8.3   | 2026-05-16 | MIT     | Deflate and zip writing (section 9.8).          |

## 12. Assumptions

1. Yjs's update format v1 stays readable by future Yjs versions (Yjs has kept it since 2020). If not, `document.json` still opens every file; only merge identity would be lost.
2. Yjs resolves concurrent writes to the same map key the same way on every replica. The tests check the outcomes that depend on it.
3. No more than a few hundred thousand elements per document; the flat element map and full-state snapshots are fine at that size.
4. Containers never need rotation or scale (frames can be stops and the camera does not rotate; group transforms are applied to members).
5. A file is read whole into memory. Files of several hundred megabytes are acceptable for phase 1; streaming is future work.
6. Users who want unbounded deep zoom accept doing it inside frames (section 7.3).
7. The cumulative show/hide semantics (section 6.4) match what users expect from builds in other tools. This needs to be checked with the users.

## 13. Open questions

1. **Compaction.** Removed records stay forever. When may they be purged (for example, removed for more than 30 days and the document not shared, or on an explicit "compact" command), and what happens to a late offline edit of a purged element? Purging must first turn frame stops that point at the purged frame into rectangle stops.
2. **Live migrations.** In phase 4, a shared document on the server may need a format or data migration while clients are connected. Running it as a Y transaction on every replica can conflict; running it once on the server and forcing old clients to upgrade is likely, but undecided.
3. **zip64.** Large embedded videos could push a file past 4 GiB. Either support zip64 (reading and writing) or keep large media outside the file and link it. Decide before the media extension.
4. **Text model.** The text layout here (Y.Text with Quill-style attributes) is provisional; the text editing work may prefer a tree (Y.XmlFragment). The generic encoding supports both, so this does not affect the file format, only the text extension's `typeVersion`.
5. **Media type.** `application/vnd.galatsa.presentation+zip` is not registered with IANA. Registering is optional and can wait until the format is stable.
6. **Visibility effects.** `VisibilityChange` has only `action` now. Fade or other effects would be added as optional keys; whether they belong there or to the transition extension is for the extension interface work.
7. **Repair writes.** Resolution never writes. Should the editor normalize stale state (cycle breakers, stale position tags, dissolved containers with children) on load or after a merge, to keep the stored state simple? Writing is safe (values converge) but makes undo and sync noisier.

## 14. Rejected alternatives

- **A `Y.Array` of child ids per container, for z-order and membership.** Moving is delete plus insert, so two users moving the same element produce two copies; moving between containers concurrently can put the element in two containers or none. Fractional keys on the element give one value per element.
- **Absolute (world) positions for all elements.** Moving a frame would rewrite every child, so a child added concurrently would be left behind, and two users moving a frame and a child would overwrite each other. It also wastes precision deep inside frames.
- **Untagged local positions.** A concurrent move and reparent would make the element jump by the offset between the old and new container.
- **One atomic "placement" value (parent, order and position together).** Simpler, but a concurrent move and reparent would lose one of the two changes entirely; the tag keeps both.
- **Hard delete (removing map entries).** Loses concurrent edits of the deleted element, which Yjs's undo cannot restore.
- **Ungroup by moving the children out.** Loses children added to the group concurrently and a concurrent move of the group.
- **Absolute per-stop visibility (each stop lists the full visible set).** Tedious to author and hard to keep consistent; builds across several stops need the same element marked at every stop.
- **Stops as camera poses (centre and zoom).** Ties stops to screen shape and to the 2D camera.
- **A single global coordinate space, even with camera-relative rendering.** The camera position itself loses precision far from the origin; limits deep zoom to roughly 2^46 / |position|. Kept only as the fallback inside one space.
- **Scale factors on frames.** Would let numbers stay "nice" deep inside nested frames, but complicates every conversion, resize semantics and stop fitting. float64's exponent range already covers tiny local coordinates.
- **Arbitrary-precision coordinates (big decimals).** Slow everywhere for a benefit only at extreme zoom.
- **The Y.Doc state as the only content of a file.** Every reader, including the player and future import/export tools, would need Yjs, and migrations would have to operate on CRDT internals.
- **JSON only, no `ydoc.bin`.** Reopening a file would always lose merge identity, so offline copies could never merge with the shared document.
- **fflate's `unzipSync` for reading.** No checksum verification and no size check before inflating.
- **Opening newer files read-only.** The reader cannot tell what it would draw wrong.

## 15. Tests

All tests run with `pnpm check` (Vitest). Concurrency tests use two Y.Docs that start from the same state, make changes independently, then exchange updates in both directions (`Y.encodeStateAsUpdate` against the other's state vector). Each test checks that both replicas end with equal JSON forms and that the outcome is the one specified above.

- `packages/core/src/ydoc/merge-elements.test.ts`: for each element type (frame, group, text, shape, image, freehand, table, chart, map, media), two concurrent edits that touch different parts both survive, and a same-key conflict converges.
- `packages/core/src/ydoc/merge-structure.test.ts`: every row of the tables in sections 4.3, 5.7 and 6.5.
- `packages/core/src/ydoc/encode.test.ts`: the generic data encoding round-trips every shared type and the `"$y"` escape.
- `packages/core/src/model/*.test.ts`: order keys, resolution (orphans, cycles, tags, dissolve, deletion), route steps and show/hide, validation, zoom clamp.
- `packages/format/src/*.test.ts`: write and read back an equal document; an unknown extension's element survives unchanged; an older format version is migrated; a newer one is refused; damaged archives, bad checksums and wrong asset hashes are reported; `ydoc.bin` keeps merge identity and is dropped when it disagrees with `document.json`.
