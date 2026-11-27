# 0001 Document model and file format

- Status: proposed, revised after the third review
- Date: 2026-11-27
- Code: `packages/core/src/model` (types, the grammar, order keys, resolution, stops and routes, purging, fragments, zoom range), `packages/core/src/ydoc` (the Yjs binding, exported as `@galatsa/core/ydoc`), `packages/format` (the file format; `@galatsa/format/read` reads without Yjs)

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

| Topic                    | Decision                                                                                                                                                                                                                                                                                                   | Section  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Storage                  | One Yjs `Y.Doc` per document. Flat maps of elements, stops, routes and assets keyed by random ids.                                                                                                                                                                                                         | 2        |
| Reading                  | One grammar, as one total reading function. The conversion from Yjs, the file reader, the file writer, validation and the operations all use it. Anything reads as a valid document; what does not fit is read as a default, left out, or kept verbatim as "unsupported", and reported.                    | 2.1, 9.6 |
| Element structure        | A fixed envelope that core understands (type, parent, order, position, size, rotation, name, lock, revision, deletes, references, open `ext` slots) plus type-specific `data` that only the extension understands.                                                                                         | 3        |
| Z-order                  | A fractional order key per element, among its siblings, in a fixed syntax. No arrays of children.                                                                                                                                                                                                          | 4        |
| Frames and groups        | Containers with a translation-only local coordinate space. Moving an element writes only its position; changing its container writes only its parent and a recorded translation, so a concurrent move and reparent both survive.                                                                           | 5        |
| Concurrency of structure | Every replica resolves the merged state with the same pure function: orphans go to the root, parent cycles are broken deterministically, positions written in another space are converted.                                                                                                                 | 5        |
| Deletion                 | Soft. A delete lists what its user saw and hides only that: anything worked on or added without knowledge of the delete survives, whether the work was on the thing itself or on a container between it and the deleted one. Restoring is work too. Work is recorded automatically for every local change. | 5.5      |
| Tidy up                  | Removed records are purged only by an explicit "tidy up" command and in exports for sharing, never by age. Tidy up rewrites nothing it keeps and turns removed frames and groups into empty place markers that are gone for good, so offline work still lands where it was.                                | 5.8      |
| Stops                    | A stop shows a region (a frame, or a rectangle in some container's space), not a camera pose. It holds notes, a transition, and show/hide changes.                                                                                                                                                         | 6        |
| Routes                   | A route is a set of entries, each pointing at a stop, ordered by fractional keys. Shared stops are stops that more than one route points at.                                                                                                                                                               | 6.3      |
| Visibility               | Show/hide changes add up along the route. An element first shown at a stop is hidden before it; in a route that skips that stop, it is visible from the start.                                                                                                                                             | 6.4      |
| Precision                | float64 throughout; parent-local coordinates; every conversion goes through the lowest common ancestor; the camera and stop regions are anchored in a container's space; rendering is camera-relative. Zoom 2^-32 to 2^32, clamped further where precision would run out.                                  | 7        |
| Assets                   | Identified by the SHA-256 of their bytes. The document holds descriptions; bytes are stored beside it, embedded in the file by default or, for very large media, in a file next to it.                                                                                                                     | 8        |
| File                     | A zip archive: `mimetype`, `manifest.json` (format version, minimum reader version, merge identity), `document.json` (canonical, plain JSON), optional `ydoc.bin` (Yjs state, to keep merge identity), `assets/`, `thumbnail.png`.                                                                         | 9        |
| Versions                 | Additive changes go into open slots and need no new reader. Incompatible changes raise the minimum reader version, which can only rise; older readers refuse to open, to sync with, to edit and to save such a document. Old files are upgraded by JSON migrations.                                        | 9.4      |
| Merge identity           | A lineage id in the document and the manifest changes whenever identity is reset; copies with different lineages refuse to merge instead of silently losing edits, and can be brought together by importing one into the other as new content.                                                             | 9.3      |
| Missing extensions       | The element's envelope is used (position, z-order, grouping), its data is kept losslessly and written back unchanged, and a placeholder is drawn. It can be moved, not resized.                                                                                                                            | 9.5      |

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
  type, typeVersion, parent, order, pos, rebase, size, rot, name, locked,
  dissolved, purged                   JSON values; last writer wins per key
  refs                                Y.Map: id -> true (a set)
  ext, data                           Y.Map: per key, a JSON value or a nested
                                      shared type (Y.Text, Y.Map, Y.Array, Y.XmlFragment)
  rev, deleted                        bookkeeping for deletes (below, section 5.5)

stop Y.Map
  name, view, transition              JSON values
  notes                               Y.Text
  visibility                          Y.Map: ElementId -> { action, ext? } (JSON)
  ext                                 Y.Map
  rev, deleted

route Y.Map
  name, order                         JSON values
  entries                             Y.Map: RouteEntryId -> { stop, order, ext? } (JSON)
  ext                                 Y.Map
  rev, deleted

rev      Y.Map: writer key -> Y.Array; the array's length is that writer's counter
deleted  Y.Map: action id -> Y.Map { seen: JSON object, id -> revision digest }
meta     also: "minReaderVersion:<n>" and "schemaVersion:<n>" -> true (section 9.4)
```

Rules that follow from the layout:

- **Granularity.** In a `Y.Map`, concurrent writes to the same key are resolved by Yjs: one value wins, the same one on every replica. Concurrent writes to different keys are all kept. Values that must change together are one JSON value under one key (`pos` holds x, y and the space together; a whole stop `view` is one value), so a merge never mixes half of one user's change with half of another's.
- **No arrays of ids for structure.** Membership is the element's own `parent` key and order is its own `order` key. A container does not list its children (section 14).
- **`meta`.** `schemaVersion` and `minReaderVersion` are the versions of section 9.4. `id` is the document's id: copies of one presentation share it. `lineage` is the merge identity (section 9.3).
- **Settings.** Document-wide settings (background, default transition) are plain JSON under keys named `<owner>.<name>`, such as `core.background`.
- **The JSON form.** `DocumentSnapshot` in `packages/core/src/model/types.ts` is the same structure as plain JSON, without `lineage`: `rev` is an object from writer key to counter, `deleted` an object from action id to `{seen}`, and `refs` a sorted array of ids. `toSnapshot` and `fromSnapshot` in `@galatsa/core/ydoc` convert both ways. The JSON form is what files store (section 9.3) and what viewers receive.
- **Update format.** Galatsa uses Yjs's update format 1 everywhere: in files and, later, on the wire. Section 3.4 depends on it.

### 2.1 One grammar

The grammar of the JSON form is one total function, `readSnapshot` in `packages/core/src/model/grammar.ts`. It turns anything into a valid `DocumentSnapshot` and lists what it had to change. Reading the result again changes nothing and reports nothing.

| What is found                                                                                                                                 | How it reads                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A value of a known key that does not fit (a negative size, a position that is not an object, an order key outside the syntax, a non-boolean)  | A fixed default: size 0, the origin, `"a0"`, false, and so on. A damaged `rebase` reads as null whole. |
| An entry of a list or map that does not fit (a reference that is not an id, a route entry without a stop, a visibility change without action) | Left out.                                                                                              |
| A record that cannot be used at all (its key is not an id; an element without a valid type; not an object)                                    | Left out.                                                                                              |
| An unknown key of a record, of the document, or of a plain value with fixed keys (a stop view, an asset description)                          | Left out.                                                                                              |
| In a value position (section 3.4): a tagged value of an unknown kind, or one whose own fields are malformed                                   | Kept verbatim as an _unsupported_ value, which every version stores and writes back unchanged.         |
| Anything nested deeper than 256 levels                                                                                                        | Cut: null inside plain JSON, an unsupported value in a value position.                                 |

Everything that produces or accepts a document uses this function or its parts, and nothing else decides what is valid:

- `toSnapshot` copies the Yjs state into plain data as it is and reads that with `readSnapshot`. So it never throws and always returns a valid document, whatever a peer wrote. `inspectDocument` also returns the list of what was changed.
- The live resolver reads elements from the `Y.Doc` with the same readers, key by key (`envelopeField`), so the editor and a saved file never disagree about an element. Records the grammar leaves out do not exist for the resolver either.
- The file reader reads `document.json` with it (section 9.6): one bad record or value costs that record or value, never the file.
- The file writer writes what `toSnapshot` returns, so a save cannot produce a file the reader does not accept. A snapshot handed to the writer directly is refused unless reading it reports nothing.
- `validateSnapshot` is "reading reports nothing".
- The operations check their arguments with the same readers before writing anything and throw `InvalidDocumentError` otherwise (`checked` in the grammar), so they cannot write what the grammar would have to change. For example, `resizeElement` with a negative width throws.

Content of the `Y.Doc` that the JSON form has no place for (unknown root types, unknown keys, records that are left out) is not part of the document. It is reported by `inspectDocument`, kept in the `Y.Doc` and in `ydoc.bin`, never part of an export for sharing, and removed by tidy up (sections 5.8 and 9.3).

## 3. Elements

### 3.1 Ids

Element, stop, route and route entry ids, document ids, lineages and delete action ids are opaque strings of 1 to 64 characters from `A-Z a-z 0-9 _ -`, never `__proto__`. New ones are 128 random bits written as 22 URL-safe base64 characters (`newId` in `model/ids.ts`), from the platform's secure random source, so replicas never need to coordinate. Readers MUST NOT give meaning to an id's content. The canvas root is `null`, not an id. Operations refuse other ids, and refuse to create a record under an id that exists; a record that a peer stored under another key is not part of the document (section 2.1). All code that builds objects keyed by ids or by data keys uses own properties (`setOwn`), so no key is special.

### 3.2 Element types

An element's `type` is `"<extension id>/<type name>"`, both parts from `a-z 0-9 . _ -` starting with a letter or digit, for example `galatsa.text/text`. The type never changes after creation. Core defines `core/frame` (section 5.2) and `core/group` (section 5.4).

`typeVersion` (an integer from 1) is the version of the layout of the element's `data`, owned by the extension (section 9.4 for how versions mix).

### 3.3 The envelope

Every element has these keys. Core and every extension understand them; they are what lets an element of an unknown type still be placed, stacked, grouped and drawn as a placeholder.

| Key           | Type                | Meaning                                                                                          |
| ------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `type`        | string              | Element type id.                                                                                 |
| `typeVersion` | integer >= 1        | Version of `data`'s layout.                                                                      |
| `parent`      | id or null          | The frame or group the element is in; null for the canvas root.                                  |
| `order`       | string              | Order key among siblings (section 4).                                                            |
| `pos`         | `{x, y, space}`     | Top-left corner of the unrotated box, in the local space of the container `space` (section 5.3). |
| `rebase`      | object or null      | Translations recorded when the element changed container (section 5.3).                          |
| `size`        | `{w, h}`            | Width and height in world units, >= 0. Not on groups.                                            |
| `rot`         | number              | Rotation in radians about the box centre, clockwise on screen. Only on extension elements.       |
| `name`        | string              | User-visible name; empty when unnamed.                                                           |
| `locked`      | boolean             | Locked elements cannot be selected or changed in the editor (section 5.6).                       |
| `rev`         | `{writer: counter}` | Revision: changes with every unit of work on the element (section 5.5).                          |
| `deleted`     | `{action: {seen}}`  | The deletes of this element; empty when there are none (section 5.5).                            |
| `dissolved`   | boolean             | Containers only: ungrouped, or removed with "keep contents" (section 5.5).                       |
| `purged`      | boolean             | Containers only: a place marker left by tidy up, gone for good (section 5.8).                    |
| `refs`        | set of ids          | Elements and stops that `data` or `ext` refer to (section 3.5).                                  |
| `ext`         | map                 | Open slots for additive envelope-level features, `"<owner>.<name>"` -> value (section 9.4).      |
| `data`        | map                 | Type-specific data (section 3.4).                                                                |

### 3.4 Type-specific data and the JSON form of shared types

`data` (and every `ext` slot map) is a `Y.Map`. Each value is a plain value (replaced as a whole when written) or a shared type that merges item by item: `Y.Text`, `Y.Map`, `Y.Array`, `Y.XmlFragment` (with `Y.XmlElement`, `Y.XmlText` and `Y.XmlHook`). Shared types can nest in shared maps and arrays, be embedded in text, and be attribute values.

In the JSON form, values in a _value position_ (directly in a data or ext map, a shared map or array, a text embed, or an attribute of a shared text or XML node) are plain JSON or an object with a `"$y"` tag:

| Yjs value                                  | JSON form                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `Y.Text`                                   | `{"$y": "text", "delta": [runs], "attributes"?: {k: value}}`                           |
| `Y.Map`                                    | `{"$y": "map", "entries": {k: value}}`                                                 |
| `Y.Array`                                  | `{"$y": "array", "items": [value, ...]}`                                               |
| `Y.XmlFragment`                            | `{"$y": "xmlFragment", "children": [node, ...]}`                                       |
| `Y.XmlElement`                             | `{"$y": "xmlElement", "name": "p", "attributes": {k: value}, "children": [node, ...]}` |
| `Y.XmlText`                                | `{"$y": "xmlText", "delta": [runs], "attributes"?: {k: value}}`                        |
| `Y.XmlHook`                                | `{"$y": "xmlHook", "hookName": "h", "entries": {k: value}}`                            |
| a plain object with its own `"$y"` key     | `{"$y": "json", "value": {...}}`                                                       |
| a plain value JSON cannot express          | `{"$y": "any", "value": tree}`                                                         |
| a value this version cannot represent here | `{"$y": "unsupported", "note": "...", "raw"?: JSON}`                                   |

- A run is `{"insert": string or value, "attributes"?: {...}}`. A string is text; anything else is an embed: a JSON value that is not a string and not null, or a tagged shared type. Run attributes are a JSON object without null values. `"attributes"` on a text or XML node holds what `setAttribute` stored, shared types included. Together these cover both kinds of editor bindings: those that keep a tree in `Y.XmlFragment` (ProseMirror, TipTap) and those that embed `Y.XmlText` in `Y.XmlText` and use node attributes (Lexical).
- Text deltas are normalized: no empty runs, and neighbouring text runs with equal attributes are one run. (Yjs's own `toDelta` splits runs at formatting marks that changed nothing, and may do so differently on different replicas.)
- An _any tree_ is the lossless form of values Yjs can store as plain content but JSON cannot: JSON primitives stand for themselves, every other node is an object with exactly one key: `{"a": [...]}` array, `{"o": {...}}` object, `{"u": 1}` undefined, `{"b": "<base64>"}` binary, `{"n": "NaN" | "Infinity" | "-Infinity"}`, `{"i": "<digits>"}` 64-bit integer. It is used only when a value is not plain JSON.
- Anything nested inside plain JSON is plain JSON, `"$y"` keys included.
- An _unsupported_ value is how a reader keeps what it cannot represent: a shared type it does not know, a tagged value nested too deep, or a tagged value of a kind, or with fields, that this version does not know. In the last case `raw` holds the original JSON. It is stored in Yjs as the plain object it is written as, so it syncs, survives saving, and reads back the same. A version that can read `raw` reads it instead: writing a newer kind of value through an older version loses nothing.

**Every replica reads the same.** The JSON form of a value is defined by how Yjs delivers the value to other replicas, not by how the replica that wrote it happens to hold it in memory; otherwise the author of an odd value would save a different `document.json` than everyone else, and its own `ydoc.bin` would not match. `rawFromY` (`ydoc/encode.ts`) therefore reads:

- plain values in shared maps and arrays as lib0's "any" encoding carries them: undefined, binary data, non-finite numbers and 64-bit integers are kept (as an any tree; larger integers wrap to 64 bits); any other object is read by its own enumerable keys, whatever its prototype; object keys named `__proto__` are left out, because lib0 loses them (keys of shared maps, data maps and ext maps are not affected; an attribute of a shared text or XML node with that name is left out too, because Yjs cannot hand it out);
- text embeds and formatting attribute values as JSON text carries them (update format 1): undefined, functions and symbols disappear from objects and become null in arrays, non-finite numbers become null, other objects are read by their own enumerable keys or their `toJSON`;
- strings as well-formed Unicode (a lone surrogate reads as U+FFFD), and negative zero as zero;
- two values that only a hand-made update can put directly into a shared type, and that Yjs's own interface cannot store there, as null: a 64-bit integer, and undefined in a shared array.

The grammar applies the same rules to JSON it is given, so `toSnapshot(fromSnapshot(s))` equals `s` for every valid `s` (tested on random documents and random junk).

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
9. Plain values hold JSON. Object keys named `__proto__` inside plain values, attributes of that name on shared text and XML nodes, and values JSON cannot express inside text embeds do not survive Yjs and are not supported.

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

An element whose `data` or `ext` refers to other elements or stops (a connector, a link, a map label pointing at a frame) stores each reference as a complete string value equal to the id and lists the id in `refs`. Core never interprets references; it uses `refs` to remap them. `refs` is a set (a `Y.Map` from id to true; a sorted array in the JSON form), and `setRefs` writes only what differs, so two users who add different references at the same time both keep theirs.

Copy, duplicate and paste go through a _fragment_ (`copyFragment` in `model/fragment.ts`): normalized copies of the selected elements and everything visible inside them (positions resolved, no rebases, revisions or delete marks, children of gone containers lifted, order keys regenerated), optionally stops and routes, and the descriptions of the assets they refer to. A rectangle stop whose space is not a frame or group among the copied elements is expressed in the space of the copied roots ([0013](0013-routes-and-stops.md)). For a frame stop whose frame is not copied and was gone where the fragment was made, the fragment also holds the rectangle the stop showed there (such a stop still works, section 6.2, and a copy of it must too). The entries of a copied route get fresh order keys in playing order. `pasteFragment` (`ydoc/document-ops.ts`) writes a fragment with new ids:

- every element, stop, route and route entry gets a new id; the old-to-new map is returned;
- parents, position spaces, frame stops, rectangle-stop spaces and visibility entries that point into the fragment are remapped; a rectangle stop whose space is not a frame or group of the fragment is read in the roots' space, so it lands in the paste's target and never names an unrelated element ([0013](0013-routes-and-stops.md)); visibility entries for elements outside the fragment are dropped; a route entry is kept if its stop is pasted too or exists in the target document;
- in `data` and `ext`, every string value and map key equal to an id that the element lists in `refs` and that was pasted is replaced; `refs` is remapped the same way; references to things not pasted stay as they were; text of rich text runs is never changed;
- roots go into the target container, moved by an offset, in front of everything the user sees there (also in front of former members of a dissolved group), keeping their relative order; routes go after the existing routes;
- a frame stop whose frame is not pasted becomes a rectangle stop if the fragment holds its rectangle;
- records are created like all records (removed, then restored in the local transaction, section 10), so undoing a paste removes softly; like every operation that creates records, paste refuses to run inside another transaction;
- asset descriptions are added to the target document; the caller copies the bytes from the source store into the target store, for every asset id the result lists.

`importCopy` pastes everything visible in another copy of a document (section 9.3), and `independentCopy` makes a new document from one ("save as a copy": a new document id and a new lineage).

## 4. Z-order

### 4.1 Order keys

Each element has an `order` key that sorts siblings (elements with the same effective parent, section 5.1) from back to front. Keys are compared as plain strings by UTF-16 code unit (never by locale); ties are broken by id, compared the same way. Higher sorts in front.

The key syntax is fixed by the format (`isValidOrderKey` in `model/order.ts`): a head letter giving the length of the integer part (`a`-`z`: 2 to 27 characters, `A`-`Z`: 27 down to 2), the remaining integer digits, then optional fraction digits not ending in `0`, all digits from `0-9A-Za-z`, at most 1024 characters, and never `A` followed by 26 zeros. This is the syntax of the `fractional-indexing` library, which generates the keys. A key that is missing or outside the syntax reads as `"a0"` everywhere (section 2.1), and key generation treats invalid neighbours as open ends.

Generated keys get three random digits appended (when the result still sorts strictly between its neighbours), so two replicas that insert at the same place almost never produce equal keys. Keys grow by about one character per six insertions at the same spot. A writer MUST NOT write a key outside the syntax, so keys are kept short: before an operation generates a key in a list (the children of a container, the visits of a route, the routes) in which some key has 128 characters or more, it re-keys the whole list, keeping its order (`makeRoom` in `ydoc/ops.ts`). The re-keying is a transaction of its own that is neither work (section 5.5) nor undoable; two users who re-key the same list at the same time write the same keys to the items they both see. The generator itself (`keyBetween`) throws rather than return a key that is too long.

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

After a merge, an element may point at a parent that does not exist (not yet delivered), at something that is not a container, or into a cycle (A moved frame F into G while B moved G into F). Every replica turns the stored state into the same _effective tree_ with a pure function (`Resolver` in `model/resolve.ts`), without writing anything:

1. A parent that does not exist or is not a frame or group counts as the root.
2. Each parent cycle is broken at its member with the smallest id, which counts as being at the root.

The rules depend only on the state, so all replicas see the same tree. Operations never "repair" the stored parent: a move writes only the position, so if a parent record simply has not arrived yet (peer-to-peer delivery), nothing is lost when it arrives (section 5.3, rule 3, then places the element correctly). The resolver computes on demand and without recursion: asking about one element reads that element and the containers above it, and trees of any depth resolve.

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

A shift is a fixed translation recorded at the time of the reparent, so the element follows its new parent and is unaffected when its old container moves later. At most 64 shifts are kept. Stale rebases (a move happened since) are harmless and stay.

### 5.4 Groups

A group (`core/group`) is an invisible container. It has a position (the origin of its local space) but no size: its bounds are the union of its visible descendants' bounds. An empty group is not drawn and has no bounds. Groups can be nested and can contain frames, and frames can contain groups.

Grouping (`ops.group`) requires the elements to be visible in the same container (the same logical parent; some may sit inside gone containers there). It creates the group in that container, in front of the frontmost member's slot, with its origin at the top-left of the members' bounds, then moves the members into it as in section 5.3. Members keep their order keys. The group is created dissolved in an untracked transaction and restored in the local one, so undoing a grouping dissolves the group (section 10).

Moving a group writes only the group's `pos`. Scaling or rotating a group is a command that rewrites the members' positions, sizes and rotations.

### 5.5 Removal: a delete hides only what its user saw

Elements, stops and routes are never removed from their maps by normal editing. In Yjs, removing a map entry while someone edits inside it discards their edits, and undo cannot bring them back. Removal is therefore a mark on the record, and the rule the users decided on is: _when one user deletes something and another, without knowing of it, works on it or on something inside it, the other user's work survives._

**Revisions.** Every record has a revision, `rev`: one counter per _writer_ (one editing session of one replica) that has worked on the record. A unit of work changes the worker's own counter. Revisions are opaque and only compared for equality: two revisions of a record are equal exactly when no work happened between them. Because each writer changes only its own entry, work by two users at the same time can never collapse into one value, whichever of them a third user had seen.

In the `Y.Doc`, a writer's counter is the length of a shared array that only that writer shortens, stored under a key made of a random session key and a sequence number. A writer's first array in a record has 8 items; when an array is down to one item, the writer replaces the entry by a new one of 64 items under a new key, so a key and counter never repeat, and neither does a revision. Shortening an array creates no new CRDT items, so recording work does not interleave with the items of the work itself: text typed one character per transaction still merges into runs (measured at 1.8 bytes per typed character, recording included).

**Digests.** Where a revision has to be remembered, its _digest_ is stored, not a copy: the empty string for the empty revision, otherwise the first 12 bytes of the SHA-256 of the revision's canonical text, written as 16 URL-safe base64 characters. The canonical text has one line per writer, `<writer key>=<counter>`, the lines sorted by writer key (UTF-16 code units) and joined by a line feed. Equal revisions have equal digests, and every implementation of the format MUST compute this same value (`model/digest.ts`; the tests pin SHA-256 to its published test vectors).

**What work is.** Three things are work on a record:

1. A change of its content: of any of its keys other than `rev` and `deleted`, or of anything nested inside it (data, ext, notes, visibility, route entries). Writing a value into a map that equals the value already there is not a change.
2. Taking back a delete that applied to it: a restore, or the undo of a delete (decided with the users: restoring is work).
3. For a stop: a new visit to it, however it comes about. That is a new entry in a route, an entry pointed at this stop instead of another, and every entry of a route that is restored or pasted. Reordering or removing visits is work on the route only.

**Recording work.** Work is recorded by the work tracker (`ydoc/track.ts`), not by the code that makes a change. After every local transaction, whatever its origin (a reference operation, an editor binding typing into a shared text, an undo or a redo), the tracker finds the record each changed shared type belongs to and decides from the list above what was worked on. (An operation can also declare work on a record, `noteWork`.) Then, in a follow-up transaction with its own origin, which undo never touches, the tracker

1. changes the revision of every record worked on, unless the record is hidden by a delete as the local user sees it at that moment, the deletes this very transaction writes aside: work done knowingly on a deleted thing (undoing an old edit of something that another user has deleted since) does not bring it back;
2. removes from every record whose revision it changed the delete marks stored on it, other than those the transaction wrote: none of them applied to the record, and after this work none ever can;
3. rewrites every delete mark the transaction wrote, so that it lists what its user sees now (below).

Transactions that load a document, create records, tidy up, re-key a list, record work, or apply another replica's updates are not work. Every `Y.Doc` a user edits MUST have the tracker attached before the first edit (`trackWork`); the reference operations, `fromSnapshot`, `forkDoc`, `createUndoManager` and the file reader attach it.

**Deletes.** Deleting element R adds one _delete mark_ to R's `deleted` map, under a new random action id: `{seen}`, where `seen` lists R and everything inside R as the deleting replica sees it, each with the digest of its revision at that moment (`Resolver.coverage`). A mark on R _hides_ an element E while E, and every container between E and R (R included), still have exactly the revision the mark lists for them; the path from E to R is taken in the effective tree. An element is _deleted_ when at least one mark hides it (`Resolver.deleters`, `isDeleted`).

A mark takes about 40 bytes for each record it lists (its id and 16 characters), whatever the history of those records, and what a mark lists is read once and kept with the stored value, so the marks in a document cost nothing per transaction.

Consequences:

- An element that was added to the deleted container, or moved into it, without knowledge of the delete is not listed: it survives.
- An element inside that someone worked on has another revision: it survives; the rest stays deleted.
- A container inside that someone worked on (a moved group, a resized subframe, an ungrouped group) survives **together with everything in it**, because the path from its contents to R leads through it.
- If someone worked on R itself, the mark hides nothing. This is "delete against an edit of the same thing: the edit wins", and "delete against ungroup of the same group: the ungroup wins" (dissolving is work on the group).
- Marks are a set. Two users who delete the same thing at the same time leave two marks, and an element is deleted if either hides it, so nothing depends on whose write wins. A user who deletes an element inside a container that another user deletes at the same time leaves a mark of their own on that element: restoring the container does not restore it.
- Restoring R (`restoreElement`, which removes all of R's own marks, or undoing a delete, which removes that user's mark) brings back everything those marks hid, unless another mark still hides it. Because restoring is work on R, an older delete of R that arrives later from a copy that was offline no longer applies, neither to R nor to what is inside it: the restore wins. If another delete that the user has received still hides R, R stays deleted and nothing is recorded: an undo takes back the user's own delete, not somebody else's.

**Marks written by undo and redo.** Undo and redo put old marks back: redoing a delete, and undoing a creation (section 10). A mark from the past lists revisions from the past and would hide nothing if anything was worked on since. So the tracker rewrites every mark a local transaction wrote to list what a delete made now would list: the element and everything in it, with current revisions. If the element is already gone (someone else deleted or dissolved it meanwhile), the visible elements inside it are not part of it for the user, since they survived an earlier removal, and are not listed.

**Dissolve.** Ungroup and "remove frame, keep contents" set `dissolved` on the container. Its children are not touched.

**Gone containers are transparent.** Deleted and dissolved elements, and place markers (section 5.8), are _gone_ (`Resolver.isGone`): not drawn, not selectable. A gone container keeps its position and its slot, so its visible children stay exactly where they are on the canvas and in the stacking order; the user sees them in the nearest container that is not gone (`Resolver.logicalParentOf`). So a survivor of a deleted frame stays where it was, now in the frame's parent.

**Stops and routes** have the same two keys. A mark on a stop or route lists only the record itself; the record is removed while some mark lists its current revision (`isRemoved` in `model/route.ts`).

**Delivery order.** The changes of different users travel separately, so a mark can arrive before work that it lists. Until that work arrives, the mark does not hide the record concerned, whose revision is not yet the one listed; when it arrives, it does. A mark that hides nothing is therefore never removed for that reason alone. Marks are removed only by a restore, and by step 2 above, which is safe: work that a replica does on a record while it holds a mark on that record cannot have been seen by the mark's writer.

**Two transactions.** The work and its recording are two transactions, sent one right after the other. A replica that has received the first but not yet the second sees the change without its new revision; a delete made in that instant lists the old revision and stops applying when the second arrives. Nothing is lost by this, but such a delete has to be repeated (section 13).

### 5.6 Locking

`locked` is an editor rule: a locked element, or one inside a locked container the user sees (not gone), cannot be selected by clicking and refuses edits through commands until unlocked (`Resolver.isLocked`). The model and the reference operations do not enforce it, so a change made concurrently with a lock is kept. Locking and unlocking are work on the element like any other change.

### 5.7 Outcomes of concurrent structural edits

These are the intended outcomes; each row has a test that runs it with the client ids in both orders (section 15). "Without knowing" means: before receiving the other user's change.

| A does                                                     | B does, without knowing                | Outcome after merge                                                                                     |
| ---------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| moves X into frame F                                       | moves X (within its old parent)        | X is in F, at B's position on the canvas.                                                               |
| moves X back into the frame its position was written in    | moves X                                | X is in the frame, at B's position.                                                                     |
| groups Y, then moves Y in the group                        | moves Y into frame G                   | Y is in G at A's position, and does not follow the old group later.                                     |
| moves X into G, then out again                             | moves X                                | X is where B put it, and follows neither G nor its first frame later.                                   |
| moves X out of frame F to the root                         | moves F                                | X is at the root where A put it; F moves without X.                                                     |
| moves frame F into frame G                                 | moves G into F                         | Cycle: broken at the smaller id, which goes to the root; the other stays inside it. Nothing disappears. |
| moves X into F1                                            | moves X into F2                        | X ends in one of them, the same on both replicas, at its place on the canvas.                           |
| three users move X into F1, F2 and F3                      | a fourth moves X                       | X ends in one frame, at the fourth user's position on the canvas, in every delivery order.              |
| groups X and Y                                             | groups Y and Z                         | Two groups; Y is in exactly one. Nothing lost or duplicated.                                            |
| groups X and Y                                             | moves X                                | X is in the group, at B's position.                                                                     |
| ungroups G                                                 | adds Z to G                            | G's children, Z included, stay visible and in place.                                                    |
| ungroups G                                                 | moves G                                | The children end where B's move put them.                                                               |
| ungroups G                                                 | deletes G                              | The ungroup wins: the children stay.                                                                    |
| deletes frame F                                            | moves X out of F                       | X survives where B put it.                                                                              |
| deletes frame F                                            | moves X into F, or adds X to F         | X survives where it is, shown in F's parent. Restoring F puts X back in F.                              |
| deletes frame F                                            | edits X inside F                       | X survives, shown in F's parent; F and the rest of its contents are deleted.                            |
| deletes frame F                                            | types into a text inside F (an editor) | The text element survives, with the typing.                                                             |
| deletes frame F                                            | moves group G that is inside F         | G and its members survive, at B's place; F and the rest are deleted.                                    |
| deletes frame F                                            | ungroups G inside F                    | G's members survive, in place.                                                                          |
| deletes frame F                                            | edits X inside group G inside F        | X alone survives, in place.                                                                             |
| deletes frame F                                            | (nobody touches it)                    | F and everything in it are deleted; restoring F restores them.                                          |
| deletes frame F                                            | deletes frame F                        | Deleted. What either of them saw in F is deleted, also what the other had just added.                   |
| deletes frame F, then undoes                               | deletes X inside F                     | F is back; X stays deleted.                                                                             |
| deletes X                                                  | edits X, or locks it                   | The edit wins: X stays, with B's edit.                                                                  |
| deletes X, having seen C's edit of X                       | edits X without having seen C's edit   | X stays, with B's edit (and C's, where they do not conflict).                                           |
| restores F, which C had deleted (or undoes its own delete) | deleted F earlier, offline             | F stays restored, with its contents: the restore wins over the older delete.                            |
| undoes its own delete of F, having received B's delete     | (deleted F at the same time)           | F stays deleted: B's delete was not taken back.                                                         |
| deletes X, B restores X and undoes the restore             | A then undoes its delete               | X is back: the undo finds the mark although another user put it back.                                   |
| undoes an earlier move of X                                | deletes X                              | X stays: an undo is an edit.                                                                            |
| undoes an earlier move of X after receiving B's delete     | (deleted X before)                     | X stays deleted. If it is restored later, it is at the position the undo gave it.                       |
| A moves X into G; B deletes G; C moves X (three replicas)  |                                        | X survives at C's position, in every delivery order.                                                    |
| locks X                                                    | moves X                                | X is locked and moved.                                                                                  |

### 5.8 Tidy up and exports for sharing

Removed records stay in the document so that offline copies, however old, can still merge (no purge by age). They are purged only by the explicit **tidy up** command, and in every **export for sharing**. The two differ, because a tidied document goes on merging and a shared export does not.

**Tidy up** (`tidyUp` in `ydoc/document-ops.ts`) permanently removes what the user no longer sees, changes nothing the user sees, and rewrites no value that it keeps (positions, parents, order keys, sizes, content), so it conflicts with no edit made elsewhere:

- Removed elements are deleted from the `Y.Doc`, except frames and groups: those are emptied (name, data, ext, references and lock cleared) and become _place markers_ (`purged`), with their position, size and slot (decided with the users). Work that an offline copy did inside a container that was meanwhile deleted and tidied therefore still lands where its author put it: an element added to the frame offline appears at the same place on the canvas, and a frame stop still shows where the frame was. A place marker is gone for good: nothing brings it back, neither an undo of "remove frame, keep contents" nor a restore made by a copy that did not know of the tidy up, so an emptied frame never reappears.
- Removed stops and routes are deleted, with the route entries and visibility entries that point at deleted records.
- Asset descriptions nothing refers to are deleted. A user who at the same time duplicates or adds something that uses such an asset keeps the description, because every use of an asset writes its description again (`addAsset`), and a concurrent write beats a delete of the same key.
- Everything this version of the format does not define (section 2.1) is deleted: records and keys, and the content of unknown root types (the root types themselves cannot be removed from a `Y.Doc`; emptied, they are no longer reported).
- Delete marks stay, without their entries for the records deleted here. A mark that hides nothing at the moment may be waiting for work that it lists and that has not arrived yet (section 5.5), so tidy up cannot know that it is dead.

Tidy up cannot be undone. Edits that an offline copy made _to a purged record_ (typing into a deleted text, restoring a deleted frame) are lost when it merges; that is why tidy up only runs on request. Place markers hold no content, only geometry; they stay until the document loses its merge identity (section 13).

**What a save holds.** Yjs keeps the content of what was deleted inside a session for as long as its undo history needs it: text that was typed and removed, values that were overwritten. A save does not write it: `ydoc.bin` is written from the state as another replica would hold it (`savedState`), in which deleted content is gone. So text that was typed and deleted is in no saved file, with or without tidy up.

**An export for sharing** (`writeGalatsaFile(..., { forSharing: true })`) writes no `ydoc.bin` and so has no merge identity; nothing will ever merge into it. Its document is purged completely (`purgeSnapshot` in `model/purge.ts`): gone elements (place markers included), removed stops and routes, entries pointing at them, unknown references in `refs`, unused asset descriptions, all revisions and marks. Surviving children of gone containers are moved into the container the user sees them in, at the same place on the canvas and in the same stacking order, and frame stops whose frame is gone become rectangle stops showing the same region. Nothing that was deleted, and nothing the format has no place for, travels with a shared file.

## 6. Stops and routes

### 6.1 Stops

A stop is what one press of "next" shows:

| Key              | Type   | Meaning                                                                                         |
| ---------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `name`           | string | Name shown in the route strip.                                                                  |
| `view`           | JSON   | The region to show (section 6.2).                                                               |
| `notes`          | Y.Text | Speaker notes.                                                                                  |
| `visibility`     | Y.Map  | Element id -> `{action: "show" \| "hide", ext?}`, applied on arrival (section 6.4).             |
| `transition`     | JSON   | Transition into this stop, defined by the transition extension; null means the route's default. |
| `rev`, `deleted` |        | Section 5.5.                                                                                    |
| `ext`            | map    | Open slots (section 9.4).                                                                       |

### 6.2 What a stop shows

A stop stores a region, not a camera pose. The player fits the region to the screen (keeping the aspect ratio, centring it), so the same stop works on any screen shape, and a different camera model (for example 3D) can show the same stops.

- `{kind: "frame", frame, padding, ext?}`: the frame's rectangle, with a margin of `padding` times its larger side. The stop follows the frame. If the frame is gone, its record (and geometry) is still there, also after tidy up, and the stop still works; if the record is missing entirely, the stop is skipped.
- `{kind: "rect", space, x, y, w, h, ext?}`: a rectangle in the local space of the container `space` (null for the root). The editor SHOULD use the innermost frame that contains the whole rectangle. If `space` is missing or not a container, the rectangle is read in root space.

`ext` is an open slot for additive hints (section 9.4). A new kind of view is an incompatible change. A view that is neither reads as a unit rectangle at the origin (section 2.1).

`stopRegion` returns the region in the most local space available, which is where the camera anchors. A transition between two stops is computed in the space of the lowest common ancestor of the two regions' spaces (`Resolver.offset`), so a flight between neighbouring stops deep inside nested frames never goes through large numbers.

### 6.3 Routes and shared stops

A route has `name`, `order` (its place in the list of routes), `rev`, `deleted`, `ext`, and `entries`: a `Y.Map` from entry id to `{stop, order, ext?}`. Playing a route walks its entries sorted by order key and id (`routeSteps`), skipping entries whose stop is missing or removed.

A shared stop is a stop that entries in more than one route point at; editing it changes it in every route. A stop can appear more than once in one route. To change a stop for one route only, the editor copies it and points that route's entry at the copy.

Removing a stop skips its entries everywhere until it is restored. Removing an entry deletes the entry's key (an entry is only a reference). Entries are ordered by keys rather than kept in a `Y.Array` so that two users moving the same entry give one result instead of a duplicate.

### 6.4 What a stop shows and hides

Each stop may show or hide elements on arrival. Along a route, the changes add up (`hiddenAt`):

1. An element whose first change in the route is "show" starts hidden (an entrance). Any other element mentioned in the route starts visible. Elements no stop in the route mentions are always visible.
2. Arriving at each step applies that stop's changes.
3. Hiding a container hides what the user sees inside it (`isHiddenBy`); a gone container hides nothing, so a change set on a group that was later ungrouped no longer affects its former members.

So "show at stop 3, hide at stop 5" means hidden at stops 1 and 2, visible at 3 and 4, hidden from 5 on. In a route that skips stop 3, the element is visible from the start until stop 5 (decided with the users). Jumping to a stop computes the state from the start of the route. When the presenter roams freely, the state of the last stop stays. In the editor, everything is visible. Several builds at one view are consecutive stops with the same view.

A visibility change is `{action, ext?}`. The two actions are the whole vocabulary of this version; how an element appears (a fade, a direction) is an additive hint and goes into `ext`, which readers keep. A new action would be an incompatible change.

### 6.5 Outcomes of concurrent stop and route edits

| A does                                   | B does, without knowing                                      | Outcome                                                                |
| ---------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| edits shared stop S's name (via route 1) | edits S's notes (via route 2)                                | Both kept; both routes show both.                                      |
| sets S to show X                         | sets S to hide Y                                             | Both kept.                                                             |
| sets S to show X                         | sets S to hide X                                             | One wins, the same on both replicas.                                   |
| changes S's view                         | changes S's view                                             | One wins whole.                                                        |
| removes S                                | edits S, or types into its notes                             | The edit wins: S stays.                                                |
| removes S                                | adds S to a route                                            | S stays (it was used).                                                 |
| removes S                                | redoes "add S to a route", or undoes "remove the visit to S" | S stays: every new visit counts, not only the operation's.             |
| removes S                                | duplicates or restores a route that visits S                 | S stays.                                                               |
| removes S                                | points an existing visit at S                                | S stays.                                                               |
| removes S                                | reorders a route that visits S                               | S is removed (reordering is work on the route, not on the stop).       |
| removes S                                | (nobody touches it)                                          | S is skipped in every route until restored.                            |
| removes route R                          | adds a visit to R, or renames R                              | R stays.                                                               |
| inserts S1 into route R                  | inserts S2 into R at the same place                          | Both entries kept, in a deterministic order.                           |
| moves entry E                            | moves entry E elsewhere                                      | E ends at one place; no duplicate.                                     |
| removes entry E                          | moves entry E                                                | E stays (a concurrent write beats a delete of the same key). Accepted. |

## 7. Coordinates, zoom range and numeric precision

### 7.1 Units

One world unit is one CSS pixel at zoom 1. The y axis points down. Zoom is screen pixels per world unit. All model and camera arithmetic uses float64. Stored numbers MUST be finite.

### 7.2 The problem

A float64 has 53 significant bits. A coordinate of magnitude m can only take values about m * 2^-52 apart, so at zoom z it can only be placed to within about m * z * 2^-52 pixels. With one global coordinate system, zooming to 10^9 a million units from the origin leaves less than a pixel. Drawing backends are worse: canvas implementations and GPUs often use float32 for transforms.

### 7.3 The decision

1. **Parent-local coordinates** (section 5.3). Content inside a frame is stored relative to the frame, so its numbers stay small however far the frame is from the world origin. Geometry inside `data` (freehand points, map features) SHOULD be relative to the element's box.
2. **Lowest-common-ancestor arithmetic.** Every conversion between spaces (`Resolver.offset`, `positionIn`, `boundsIn`), in resolution and in every operation (reparent, grouping, restacking out of gone containers, purging, copying), sums local positions from both spaces up to their lowest common ancestor, smallest numbers first, and never goes through world coordinates. Moving an element between two frames inside a frame at x = 2^60 keeps a local position of 3e-7 exact (tested).
3. **Anchored camera.** The camera (`CameraView` in `model/geometry.ts`) is a centre and a zoom in the local space of a container (or the root). The renderer SHOULD anchor it in the innermost frame that contains the view and re-anchor as the view moves. The editor does so with the centre of the view ([0009](0009-camera.md)). Stops store regions in the same way.
4. **Camera-relative rendering.** The renderer computes each element's position relative to the camera's anchor with `Resolver.offset`, multiplies by the zoom, and passes only the resulting small screen coordinates to the drawing backend. Text is laid out at its on-screen size.

**Zoom range.** `MIN_ZOOM` = 2^-32 and `MAX_ZOOM` = 2^32 (a ratio of about 1.8 * 10^19). A web map spans about 2^20.

**Precision budget.** The error on screen is about |c| * z * 2^-52 pixels, where c is the camera centre in its anchor space. Keeping |c| * z <= 2^46 (`PRECISION_BUDGET`) keeps it at or below 1/64 pixel. The camera clamps zoom to `min(MAX_ZOOM, 2^46 / max(|cx|, |cy|, 1))` (`maxPreciseZoom`), so precision runs out as a zoom limit, never as jitter.

Practical meaning: the full zoom range is available near the origin of every frame, however far that frame is from the world origin (each frame starts a fresh budget, and frames nest); at the root, it is limited only far from the origin. Zoom is absolute (frames have no scale), so `MAX_ZOOM` is the deepest zoom anywhere. A first renderer MAY anchor the camera at the root only; anchoring in frames needs no change to the document.

## 8. Assets

### 8.1 Identity

An asset is a binary file the document uses (an image, a video, a font). Its id is `sha256-` followed by the lowercase hex SHA-256 of its bytes, so the same file added many times, by any number of users, is one asset. SHA-256 is available through Web Crypto in browsers, the desktop web view and Node.

### 8.2 In the document

The `assets` root map holds, per asset id, an `AssetInfo`: `mediaType`, `byteLength`, and optionally `name`, `width`, `height`, `external` (section 8.4) and `ext` (an open slot for additive facts about the asset, section 9.4). The bytes are not in the Y.Doc. They live in an asset store: the file's `assets/` folder, a file next to the presentation, the app's local cache, or, later, the sync server. Derived versions (downscaled images, posters) are a cache, never part of the document.

### 8.3 References and which assets a file carries

An asset is referenced wherever its id appears as a complete string value: in element `data` and `ext`, in stops (transition, notes embeds, `ext`), in routes' `ext`, and in settings (`referencedAssets` in `model/walk.ts`); text of rich text runs does not count. Nothing else needs to be declared, so assets used by elements of unknown types, by transitions or by the background are never forgotten.

A normal save writes the bytes of every referenced asset, removed records included, so restoring something after reopening finds its image. Tidy up and exports for sharing purge first (section 5.8), so assets only removed content used are left out. An asset whose bytes are missing is a normal state: the element shows a "missing asset" placeholder, and the reader warns only for assets that visible content uses.

Whoever writes a reference to an asset registers its description in the same command (`addAsset`), also when the description is there already: it is written again, so that a tidy up made elsewhere at the same time (section 5.8) cannot leave the new reference without one. If visible content nevertheless refers to an asset the document does not describe, the bytes are still written and read, and the reader says so (`asset-undescribed`).

On reading, each asset's bytes MUST be hashed and compared with its id; a mismatch means damage, the asset is treated as missing and the user is told.

### 8.4 Very large media

Media is embedded in the file by default. For very large files the user can choose to keep the media in a file next to the presentation: its `AssetInfo` then has `external: {path}`, a plain file name (no folders, drive letters, `.` or `..`) relative to the presentation file's folder, and the writer does not embed the bytes. The app looks for the file there and verifies its hash. When the presentation is moved without the file, the asset is missing (section 8.3).

## 9. File format

### 9.1 The archive

A Galatsa file (extension `.galatsa`) is a zip archive:

```
mimetype                 "application/vnd.galatsa.presentation+zip", first entry, stored
manifest.json            versions and merge identity (9.2), stored
document.json            the document in JSON form (9.3), deflated
ydoc.bin                 optional: the Yjs state (9.3), deflated
assets/sha256-<hex>      one entry per embedded asset, the raw bytes, stored
thumbnail.png            optional: preview, longest side at most 512 pixels, stored
```

- `mimetype` comes first and is stored, so tools that look at the first bytes can recognize the file.
- **Only `document.json` and `ydoc.bin` are compressed.** Assets are stored as they are, whatever their type: most are compressed already, and a reader then needs no memory for them beyond the file itself (section 9.7). (Compressing some assets by media type was the first design; an uncompressed PDF or TIFF then counted against the reader's limit for decompressed data, and the writer could write files the default reader refused.)
- **One way to read an archive.** Galatsa files use a strict subset of zip, so that no two readers can find different contents in the same bytes. The writer (`writeZip`, own code) writes exactly this subset, and readers MUST reject everything else: an archive comment (the end record is the last 22 bytes of the file); bytes that belong to no entry, before, between or after the entries; entries that share bytes; a directory that does not end exactly at the end record; a local header that differs from the directory in name, flags, method, checksum or sizes; sizes kept after the data (a "data descriptor"); entry names that are not printable ASCII, are absolute, or have `..`, `.`, backslashes or empty segments; duplicate names; encryption; archives split over several files; compression methods other than stored and deflate.
- **Unknown entries** are checked structurally, not decompressed, and ignored. Writers do not carry them over. A new kind of entry can therefore only hold something that may be lost when an older version saves the file (a cache, a second preview); anything that must survive raises the minimum reader version (section 9.4).
- **Size.** Zip without zip64 ends at 4 GiB and 65 534 entries. The version 1 writer refuses to write a file beyond that, with an error that says so and points to keeping very large media next to the presentation (section 8.4); it never writes an archive whose offsets have wrapped around. Zip64 is not part of version 1, because a file is read whole into memory (section 12) and no platform Galatsa runs on reliably holds more than 4 GiB in one buffer: zip64 belongs with reading and writing files as streams. It can be added then without breaking anything: a writer uses it only for files that need it and sets `minReaderVersion` to the version that reads zip64. Version 1 readers detect zip64 in every form it takes (the zip64 end locator, an entry count of 0xFFFF, a size or offset of 0xFFFFFFFF in the end record or in an entry, a zip64 extra field) before reading the manifest, and refuse the file as needing a newer version of Galatsa. Files below 4 GiB stay readable by every version.

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
- `ydoc` is present exactly when `ydoc.bin` is: its encoding (`Y.encodeStateAsUpdate`, update format 1) and the lineage of the Y.Doc it holds. A reader MUST NOT decode `ydoc.bin` unless `ydoc` is present with an encoding it knows.
- `thumbnail` is present when `thumbnail.png` is.
- Fields a reader does not know are ignored and not written back, like unknown entries (section 9.1).

### 9.3 document.json, ydoc.bin and merge identity

`document.json` is the canonical content: a `DocumentSnapshot` as UTF-8 JSON, removed records included (section 5.5). It is enough to open the file. Writers write object keys sorted, so the same document gives the same bytes; readers MUST NOT depend on key order. `readGalatsaSnapshot` (entry `@galatsa/format/read`) reads only this, so the player needs no Yjs.

`ydoc.bin` only preserves CRDT identity: a document reopened from it can still merge with other copies (another user's offline edits, the sync server's state). It is the Yjs state as another replica would hold it, without the content of what was deleted (section 5.8).

**Lineage.** A Y.Doc's `meta.lineage` is a random id created with the document's CRDT identity: by `initDocument`, and anew whenever identity is reset: `fromSnapshot` (opening a file without a usable `ydoc.bin`, an export for sharing, a migrated file). Two Y.Docs built from the same `document.json` have different lineages. Sync MUST refuse to exchange updates between documents with different lineages (`checkSync`; `syncDocs` throws `MergeIdentityError`); merging them would compare unrelated CRDT histories and silently drop one user's edits. A _blank_ replica (a new `Y.Doc` that holds nothing yet) has no lineage and may join any document; it receives the lineage with the content. The lineage is not part of the JSON form.

**Reading a file** (`readGalatsaFile`):

1. The archive must open (section 9.1) and the manifest must be readable and say that this reader is new enough (section 9.4). Otherwise the file cannot be opened.
2. `document.json` is parsed, migrated if the file is older (section 9.4), and read by the grammar (section 2.1). It is _usable_ if it is a JSON object that has the document's tables (`settings`, `elements`, `stops`, `routes`, `assets`). Records and values inside that do not fit are read as defaults, left out or kept as unsupported values, and listed in a warning; they never make the file unreadable.
3. `ydoc.bin` is _usable_ if the manifest describes it, its entry is intact and no larger than a limit (default 256 MiB), no migration ran, it decodes, it is complete (it holds no updates that wait for others), and its `meta.lineage` equals the manifest's. If the state it holds needs a newer reader than this one (section 9.4), the file is refused as needing a newer version, whatever the manifest says.
4. If both are usable and the JSON form of the decoded Y.Doc equals the document of step 2 (apart from the two version numbers), the Y.Doc from `ydoc.bin` is the document: merge identity is kept. Its versions are raised to those of step 2 if they are lower, and never lowered.
5. If both are usable but differ, `document.json` wins: it is what other tools read and may have changed deliberately. The document is built from it with a new lineage, and the user is told that it will not merge with other copies.
6. If only `document.json` is usable, the document is built from it with a new lineage.
7. If only `ydoc.bin` is usable (`document.json` is missing, fails its checksum, is not JSON or has lost its tables), the document is _recovered_ from `ydoc.bin`, merge identity included, and the user is told. The reader without Yjs cannot do this and reports the file as damaged.
8. If neither is usable, the file is damaged.

Both sides of the comparison in step 4 go through the same grammar, so an odd value in the Yjs state reads the same from `ydoc.bin` as it was written to `document.json`, and does not cost the file its merge identity.

**Content the format has no place for.** A `ydoc.bin` may hold more than its JSON form: an unknown root type, an unknown key in a record, a record under a key that is not an id. Such content is not part of the document, but the reader keeps the Y.Doc as it is (deleting it would be a silent loss, and one odd key from one peer would otherwise cost every user their merge identity on every reopen). It is listed in a `content-quarantined` warning and by `inspectDocument`, it never travels in an export for sharing, and tidy up removes it (root types cannot be removed from a Y.Doc and stay listed).

**When merge identity is lost.** Two copies with different lineages cannot be synced. So that work in one of them is not stranded, `importCopy` (`ydoc/document-ops.ts`) brings everything visible in another copy into a document as new content with new ids: its elements beside what is there (moved by an offset), its stops and its routes. Nothing is merged record by record, so nothing is overwritten; the user removes what is double. One undo removes the import.

### 9.4 Versions, open slots and migrations

**Two numbers.** `schemaVersion` (in the document, and `formatVersion` in the manifest) is the version of the content: the highest format version that wrote it. `minReaderVersion` is the oldest reader that can read it correctly. Both are 1 in this specification.

**Versions only rise.** In the `Y.Doc`, a version is raised by adding a key to `meta`: `"minReaderVersion:<n>"` or `"schemaVersion:<n>"` with the value true (`raiseVersions`). The version in effect is the highest one named, in the base keys `minReaderVersion` and `schemaVersion` (written once, when the document is created) or in such a key (`versionsOf`); `schemaVersion` is at least `minReaderVersion`. Keys are only added, so two clients that raise a version at the same time end with the higher one whichever write Yjs lets win, and nothing a client of any version does lowers it. Readers and writers of every version MUST use the version in effect and MUST NOT lower a version in any other way.

**Additive changes** need no new reader. They go into open slots that every reader keeps and writes back:

- the `ext` maps of elements, stops and routes (`"<owner>.<name>"` -> any value of section 3.4), and `settings`;
- the `ext` objects of the plain JSON values with fixed keys: an asset description, a route entry, a stop view, a visibility change (`"<owner>.<name>"` -> JSON);
- in every value position (data, ext maps and everything nested in them): a tagged value of a kind an older reader does not know is kept verbatim as an unsupported value and restored by a reader that knows it (section 3.4).

Examples: alt text, opacity, links, how an element fades in at a stop, a licence note on an asset, a pause at one visit of a stop. A writer that adds such content may raise `schemaVersion` but leaves `minReaderVersion`. A reader whose version is at least `minReaderVersion` opens the file, keeps what it does not understand, and writes the file back with the same versions (tested: a version 1 reader keeps version 3 additions).

**Everything else is closed**, and a change there is incompatible: a new key in a record or in the document, a new kind of stop view, a new visibility action, a changed meaning, an archive entry or manifest field that must survive a save by an older version, zip64. A version 1 reader leaves unknown keys out (section 2.1), so a writer that relied on them would lose data silently; such a writer MUST raise `minReaderVersion`.

**A document that needs a newer reader is not touched** by an older program, in any way:

- the file reader refuses the file with "needs a newer version of Galatsa" (from the manifest, from the document's own `minReaderVersion` if that is higher, or from what the state in `ydoc.bin` says);
- sync refuses a replica whose minimum reader version is higher than this program reads (`checkSync` returns `needs-newer-version` before any update is exchanged);
- a replica that is not a document yet (a new `Y.Doc` that has neither been initialized nor synced) is not written to either: content created in it would have no merge identity, and the replica could then never sync. Operations throw until it has synced.
- if the document starts to need a newer version while this program has it open (a newer client in the same session uses something new; it MUST raise the minimum reader version in the same transaction), `watchVersion` tells the program at once, every reference operation and tidy up throw `NewerVersionError`, and the file writer refuses to save, because the save would drop what this version cannot read. The shared state itself is not changed by the older program.

Opening read-only was rejected: the reader cannot know what it would misdraw.

**Migrations.** A file whose `formatVersion` is lower than the reader's is upgraded on load. Only steps that change content have a migration (`from` -> `from + 1`); other steps just raise the version numbers. A migration is a pure, deterministic function on the parsed manifest and document (plain JSON, before the grammar reads it) and leaves element data it does not own alone. If any migration ran, `ydoc.bin` is discarded and the document gets a new lineage; if only numbers were raised, merge identity is kept. Migrations are registered in `packages/format` and never removed.

**Policy for keeping merge identity** (decided now, before any extension ships):

1. Format changes are made additive wherever possible, so they never reset merge identity.
2. Readers do not migrate element data on load. An extension MUST read every older `typeVersion` of its own data, and a live document may mix `typeVersion`s of one type. An extension upgrades an element's data only when a user edits that element, just before the edit: the upgrade writes and `setTypeVersion` (which never lowers the version) go in one transaction of their own, with origin `ORIGIN.upgrade`, which counts as work but is not undone, because an upgrade keeps the meaning of the data. Every key a later layout adds is optional, and readers read it, when missing, as a default that means what older layouts implied, so most upgrades only raise the version and two users upgrading concurrently cannot overwrite each other's edits (see [0005](0005-extension-interface.md) section 3.8).
3. An element whose `typeVersion` is higher than its extension knows is treated as an element of a missing extension (section 9.5) and never down-migrated.
4. An incompatible format change that cannot avoid a migration resets merge identity; old copies are then refused by sync rather than merged wrongly, and `importCopy` is the way to bring their work over. Migrating live shared documents is an open question (section 13).

### 9.5 Elements from missing extensions

When the reader does not have the extension for an element's type (or has an older version of it):

- **Kept:** the element is loaded as is; its `data` and `ext` are converted with the generic encoding of section 3.4 and written back unchanged. Its assets are kept, because references are found by scanning.
- **Drawn:** as a placeholder: a box with the element's position, size and rotation, labelled with a localized "Missing extension" and the type id.
- **Editable** only through the envelope: move, z-order, into and out of frames and groups, lock, delete, duplicate and paste (references in `refs` remapped as in section 3.5). Resizing, rotating and editing the content are disabled, because the extension may tie the box to the content (decided with the users).
- **Tested:** a round trip through a file leaves the element's JSON form equal, with and without `ydoc.bin`.

### 9.6 Reading, damage and what the user is told

A file either opens or is refused with one `FileFormatError` whose code says why; no other error escapes the readers for any input.

| Code            | Meaning                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `not-zip`       | Not a zip archive at all.                                                                                   |
| `not-galatsa`   | A zip archive, but not a Galatsa file.                                                                      |
| `damaged`       | A broken archive structure, an unreadable manifest, or neither `document.json` nor `ydoc.bin` usable (9.3). |
| `newer-version` | Needs a newer Galatsa (9.4), zip64 included.                                                                |
| `too-large`     | Over the limits of section 9.7. Also what the writer throws for a file that does not fit (9.1, 9.7).        |
| `unsupported`   | An archive feature the format does not use (encryption, split archives, another compression method).        |

Everything else is a warning on a file that did open: `content-quarantined` (with the list of what was read as a default, left out or kept as unsupported; section 2.1), `document-recovered`, `ydoc-discarded`, `migrated`, `asset-damaged` (an asset entry fails its checksum or its hash), `asset-missing`, `asset-undescribed` (section 8.3), `thumbnail-missing`. A damaged entry costs that entry, not the file. The writer returns the bytes and its own warnings: `ydoc-not-written` when Yjs cannot encode the state (section 13) or the state is larger than a reader accepts, in which case the file is written without `ydoc.bin` rather than not at all.

The grammar does not check references: dangling parents, frames, stops and assets are legal and handled by resolution. Recovering the last good version after an interrupted save is the job of the saving code (write a temporary file, then replace); see [0006](0006-storage.md).

### 9.7 Limits

**The writer keeps the limits that the reader's defaults allow**, so a file that the writer writes is always one that the default reader opens:

| What                          | Writer                                              | Reader (default)                           |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------ |
| `document.json`, uncompressed | at most 256 MiB, else the file is refused           | decompressed entries: 512 MiB in all       |
| `ydoc.bin`, uncompressed      | at most 256 MiB, else left out (`ydoc-not-written`) | 256 MiB, else ignored (`ydoc-discarded`)   |
| assets, thumbnail, manifest   | stored, never compressed                            | views of the file's bytes: no extra memory |
| the whole file                | at most 4 GiB and 65 534 entries, else refused      | zip64 refused as needing a newer version   |

- **Memory.** Stored entries are returned as views of the file's own bytes, so embedded media costs no memory beyond the file. The entries that have to be decompressed are bounded in total by `maxInflatedSize` (default 512 MiB), checked against the sizes the directory declares before anything is decompressed. Reading a file therefore needs at most the file plus that limit. Each entry is inflated in 16 KiB steps into a buffer that grows with the data, never past the declared size, so an entry that declares much and holds little costs little, and one that holds more than it declares is stopped there. The result must match the declared size and CRC-32. A reader tolerates compressed assets (they count against the limit); the writer never writes them.
- **`ydoc.bin`** is used only under the conditions of section 9.3.
- **Nesting:** the JSON form is at most 256 levels deep; deeper content is cut (section 2.1). All conversions and the resolver are bounded or iterative, so no input overflows the stack in Galatsa's own code (section 13 for Yjs's).
- **Small bounds in the grammar:** 64 shifts in a rebase, counters in a revision up to 4096, order keys up to 1024 characters (writers keep them under about 130, section 4.1), ids up to 64.

### 9.8 The zip library

Requirements: a license compatible with GPL-3.0-or-later, no dependencies, works in browsers, the desktop web view and Node without platform APIs, and small, because the player reads files and exported presentations embed the player.

| Candidate                                                     | License                 | Size                                             | Notes                                                |
| ------------------------------------------------------------- | ----------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| [fflate](https://www.npmjs.com/package/fflate) 0.8.3          | MIT                     | 797 kB unpacked; tree-shakes to what is imported | No dependencies. Sync, async and streaming APIs.     |
| [JSZip](https://www.npmjs.com/package/jszip) 3.10.2           | MIT or GPL-3.0-or-later | 693 kB unpacked                                  | Four dependencies; larger in a bundle.               |
| [zip.js](https://www.npmjs.com/package/@zip.js/zip.js) 2.25.0 | BSD-3-Clause            | 8.7 MB unpacked                                  | Streaming, zip64, encryption; much more than needed. |

Licenses and sizes are from the npm registry, checked 2026-11-26.

Choice: **fflate for compression, own code for the archive structure.** The writer builds the archive itself and uses fflate's `deflateSync` (fflate's own zip writer does not check the 4 GiB limit, and its offsets wrap around silently). The reader parses the zip directory itself and uses fflate's streaming `Inflate`, because the checks of sections 9.1 and 9.7 need control fflate's unzip does not give.

Measured bundle sizes (Vite 8 production build, minified, then gzip; measured 2026-11-27 on this revision with a throwaway script, not part of the repository):

| What                                                                 | Minified | Gzip    |
| -------------------------------------------------------------------- | -------- | ------- |
| zip reader (`readZip`)                                               | 12.1 kB  | 4.7 kB  |
| zip writer (`writeZip`)                                              | 11.3 kB  | 4.6 kB  |
| `@galatsa/core` model (no Yjs)                                       | 54.2 kB  | 15.9 kB |
| `@galatsa/format/read` + resolution and routes (what a player needs) | 56.2 kB  | 17.7 kB |
| `@galatsa/core/ydoc` (includes Yjs and lib0)                         | 208 kB   | 54.9 kB |
| `readGalatsaFile` (reads into a Y.Doc)                               | 179 kB   | 49.0 kB |

## 10. Undo

Undo and redo are built (in the command layer) on Yjs's `UndoManager`, as the subclass that `createUndoManager` returns (`DocumentUndoManager` in `ydoc/track.ts`). It tracks the transactions of the local user: those of the reference operations (`ORIGIN.local`) and those of the origins it is given, for example an editor binding, so typing and commands are in one undo history. Loading, record creation, tidy up, re-keying, the recording of work and remote changes are never undone.

**Creation.** Undo MUST never hard-delete a record, because that would discard other users' concurrent work inside it. So every record is created in two transactions: first, untracked (`ORIGIN.create`), already removed (an element, stop or route with a delete mark that lists itself; a group dissolved); then, in the local transaction, restored. Undoing a creation puts the removal back; redoing takes it away again.

This only holds if the first of the two transactions really is one of its own. Inside another transaction it would become part of that one, undo would delete the record for good, and what another user did inside it meanwhile would jump or be lost. So every operation that creates records (`addElement`, `group`, `addStop`, `addRoute`, `pasteFragment`, `importCopy`) refuses to run inside a transaction that is not one of the internal ones, with an error that says what to do instead.

**Commands of several operations.** A command that needs several operations to be one undo step runs them in `group(fn)` of the undo manager, not in one Yjs transaction: the operations run as they always do, and the manager makes one step of them, whatever its capture timeout.

How undo meets section 5.5:

- **Undo never writes a revision.** Revisions are only written by the work tracker, in transactions undo does not see. An undo or redo is itself a local transaction, so the records it changes are worked on like by any edit: an undo made without knowing of a delete keeps the element, and an undo made after receiving the delete leaves it deleted.
- **Marks put back by undo or redo are refreshed** to what the user sees at that moment (section 5.5). So redoing a delete deletes again although the element was edited in between, and undoing a creation removes the element, with what the user sees in it at that moment, although it was edited since it was created (decided with the users). What another user added or changed without knowing still survives, as with any delete: undoing a grouping dissolves the group and a member another user added meanwhile stays in place; undoing a creation while another user types into the element keeps it, with their text.
- **Each user's delete is its own mark**, so undoing a delete brings back exactly what that delete hid and nothing another user deleted. Undoing a delete is a restore, and so is work on the element (section 5.5).
- **An undo finds its mark although someone else put it back.** If another user restored the element and then undid that, the mark is there again, but as a new entry under the same action id, which Yjs does not connect with the entry this user's undo history holds; the undo would silently do nothing, or undo an earlier step instead. The undo manager connects the two (the way Yjs does on the replica that put the mark back), so one press takes the delete back.
- **An undo never leaves a key without a value.** When an undo has to bring back the value a key had before, Yjs refuses if a concurrent write by someone else to the same key is on record, even one that lost and is gone. The key is then left with no value at all, and a position or a parent would read as its default: the element would jump to the origin. The undo manager puts the value back in that case, and only when the key has no value, so nothing anyone wrote is overwritten. This happens before the work tracker judges the undo (below): judged on the state with the hole, an element whose parent had no value would sit at the root, outside a delete that hides it, and the new revision the tracker gave it would bring it back for good.
- **An undo never takes an element out of another user's delete, and never undoes another user's move in effect.** An undo or redo that changes an element's container (taking back a move into a frame, a grouping, a move out of a frame) is finished before its work is judged (`settleStep` in `ydoc/track.ts`):
  - **Out of a delete: held back.** If the change would take the element, or something inside it, out of a delete that hides it, the element keeps the place it had before the undo (container, rebase, order key and position). A delete hides only what is inside the deleted element, so without this, undoing "move X into frame F" after receiving another user's delete of F would bring X back, while undoing a move of X after receiving a delete of X itself leaves X deleted. An undo made after receiving a delete leaves what the delete hides deleted, also when the element was deleted with its container.
  - **Moving it on the canvas: done, keeping the place.** If the change would move the element, or something shown inside it, on the canvas although the step writes no position its place depends on, the change of container is done, and the element gets a rebase (section 5.3) that keeps it where it was on the canvas. A change of container never moves anything on the canvas, and neither does undoing or redoing one; what would move it is a move another user made since (of the group being ungrouped by the undo, or of the frame the element was put in), and that move must not be taken back in effect. Undoing a grouping after someone moved the group leaves the members where that move put them, as an ungrouping would; undoing a move into a frame after someone moved the frame leaves the element where the frame took it, now outside it. Like a reparent's, the rebase shifts the stored position for the container the element is in now and for the one other users saw it in before, so a concurrent move written in either lands where its author put it.

  A first version of this rule held such a change back too, leaving the element in its container. That proved worse than what it prevented: the user's undo was never done, the next undo of the same user could then remove the element with the container it was left in (undoing the creation of a frame after a held-back undo of putting another user's element into it hid that element), and the writes that held it back stood in the way of later undos and redos of the same keys, so that one press could skip to an older, unrelated step. Doing the change with a kept place has none of these effects: the user's undo is done, and the other user's move is kept.

  Both are judged against the document placed as before the undo (the place keys the undo replaced: parent, rebase, order key, position) but with the marks as they are after it, so an undo that takes back the user's own delete still restores. They are judged for every element the step affects, not only those it changes: what is inside a moved element, what changes its effective parent because a cycle was made or broken, and what has its position written in the space of a moved container (rule 3 of section 5.3 converts from there). An element whose place depends on a position the step writes may move. A change is held back, or given a rebase, for the moved elements the finding depends on (all of them when that cannot be told).

  **The finishing writes are part of the step.** The undo manager tracks their origin and joins what they write to the stack item of the step (Yjs makes a stack item of its own for every tracked transaction while undoing; the manager merges it into the step's and removes it). So a redo, or a later undo, takes them back together with the rest of the step, and nothing they wrote stands in the way of a later undo or redo of the same keys, with the exception in section 13, item 25. The same holds for filled holes. The writes are not work: the undo itself is judged as one.

  An undo or redo that changes a container costs one pass over all elements with two resolutions of the document (before and after); other undos cost nothing extra. Measured with 5000 elements in 50 frames: 55 to 105 ms per such undo or redo, against under 1 ms for undoing a move (section 13).

Route entries are references and are deleted by undo of an insertion; asset descriptions are added untracked.

## 11. Where the code lives, and dependencies

- `packages/core/src/model`: everything that does not need Yjs: the JSON-form types, the grammar, order keys, resolution and the live resolver, stops and routes, purging for exports, fragments, reference scanning, zoom range. Exported from `@galatsa/core`.
- `packages/core/src/ydoc`: the Yjs binding: root layout, the generic data encoding, `toSnapshot`/`fromSnapshot`/`inspectDocument`, the work tracker and the undo configuration, reference operations, tidy up, paste and import, sync checks, and the live resolver of a `Y.Doc` (`liveResolver`). Exported from `@galatsa/core/ydoc`. Test helpers (a seeded random source, a sample document, the random scenario and junk of the property tests) are a separate entry, `@galatsa/core/testing`, not part of the production entries.
- `packages/format`: reading and writing files, asset hashing, migrations. `@galatsa/format` has everything; `@galatsa/format/read` reads into the JSON form without Yjs.

The Yjs binding is in core because the document model _is_ a Y.Doc; it is a separate entry so the player can use the types and resolution without Yjs. Core stays environment-agnostic: no DOM or Node types; it uses only `globalThis.crypto.getRandomValues`. The SHA-256 of the revision digests (section 5.5) is own code in `model/digest.ts`, because the platform's is asynchronous and resolution is not.

**The live resolver.** Resolution is a pure function of the state, but resolving a large document anew after every change is too slow for an editor. `liveResolver(doc)` in `@galatsa/core/ydoc` gives the document's one `LiveResolver` (`model/live.ts`): a `Resolver` that is kept up to date with every change, whatever made it (an operation, an editor binding, another replica's update, undo and redo, tidy up, loading), and answers exactly as a new `Resolver` of the same state would. Those who draw read through the same interface as `Resolver` (position, size, rotation, order, visibility per element, the children of a container) and subscribe to the changes (`subscribe`): a `ResolvedChanges` with the element ids that were added, changed or removed, the containers (null for the root) whose children or logical children changed, and whether the drawing order may have changed. They never see Yjs events. Only the binding can tell it of changes (`update` and `rebuild` are protected); `detachLiveResolver(doc)` stops it following the document.

**When it is updated, and what subscribers see.** Yjs ends transactions in batches: a transaction, and the transactions its observers start while it ends (the work tracker records every local change that way, and an editor binding may react to a change by writing), are ended one after the other, and then Yjs emits `afterAllTransactions`. The live resolver takes in the whole batch there, at once, and calls each subscriber once for the batch, with what the batch changed; the live resolver then shows the document as the whole batch left it, which is also what subscribers see. Before that (inside a transaction, in Yjs observers and in `afterTransaction` listeners) what it has resolved is as the previous batch left it; it reads records through the document, though, so a record it has not read yet (`get`, `ids`) already shows the new content, and so does a detached live resolver. An operation of several batches (`addElement` creates the record in one and restores it in the next) calls the subscribers between them. A subscriber may write: what it writes is taken in after it and reported in a further round (later subscribers of the same round may meanwhile read a record that no report or children list has yet), and a subscriber that writes every time it is called never lets this end, as with a Yjs observer that does. Taking in each transaction on its own does not work: when it is taken in, a later transaction of the batch has already written, and reading that state with the changes of the first left parts of the cache out of date (a delete stayed in effect after the work tracker had brought the element back; a cached cycle made a walk up the tree endless).

**When something goes wrong.** Each subscriber is called on its own: one that throws does not keep the others, the other listeners of the document, or the code that made the change from going on, and its error goes to the error handlers (`onError`; without one, to the platform's `reportError` where there is one). A batch whose `afterAllTransactions` does not reach the live resolver (another listener threw before it) is taken in when the live resolver is next asked for (`liveResolver`, `currentResolver`) or the next batch ends. If a change cannot be taken in (an error), or a walk through the tree finds a loop in the cached parents or children (every walk up the tree watches for one, and every walk down it after 10 000 steps), the live resolver resolves the whole document anew from nothing and reports every element as added, changed or removed relative to what the subscribers last heard, and the error goes to the error handlers. Neither should happen; they are there so that a defect costs a full resolution, not a wrong picture or a hang.

What _changed_ means, for someone who draws: anything the Resolver answers about the element may be different, or its record changed otherwise (data, ext, name, references, type version). That includes elements that changed only because something above them did: the contents of a frame that moved (their world position changed), everything inside a deleted, restored or dissolved container (gone or back), everything inside a container that was locked, groups and gone containers whose bounds changed with what is inside, and a container whose children changed. A deleted element is changed, not removed; removed means the record left the document (tidy up) or is no longer a valid element. The content of a container (its size, its `clip`) is reported for the container alone: whoever draws its contents knows they are inside it. A transaction that only records work (section 5.5) changes nothing that is shown and is not reported, unless the new revision changes what a delete hides.

How it stays up to date: the binding finds, from the transactions of the batch, which element records changed and which of their keys. From that, the live resolver collects what may be cached wrongly and what may resolve differently, following what resolution depends on: a changed parent or type, or a record that came or went, reaches everything below it by _stored_ parent, whether that parent exists or not (late parents, cycles); a changed delete mark, everything below in the effective tree, as does a new revision if it changes which deletes hide the element; a changed position, everything below (world positions) and every position converted through it (rule 3 of section 5.3, found by the space positions were written in); a changed `dissolved`, `purged` or `locked`, everything below (logical parents, locks); and every change, the groups and gone containers above whose bounds depend on it. It drops what the Resolver cached about the first set (`Resolver.forget`, which also updates the children index; the members of a broken cycle are forgotten together), resolves the second set again and compares with what it had. The property tests check the live resolver after every batch of the random scenarios of section 15 (three replicas, syncs, undo, tidy up) against a new resolution of the whole document, and check that what it reported covers every element and container whose answers or record changed; a second random test does the same on states that only concurrent edits produce (parent cycles, missing parents, converted positions, marks that apply or not), and removing any one of the dependency rules makes it fail.

The reference operations use the live resolver when the document has one and it shows the current state (`currentResolver`): every transaction is taken in, and the transaction open now, if any, has not written yet. The live resolver an operation takes before its first write goes on showing the state from before its transaction until the batch ends, which is what the operations read before they write. Otherwise (after a write in the open transaction, or in observers and listeners before the batch is taken in) they create a new `Resolver`, which reads the document as it is when asked, as before. Tidy up, which decides on the state before its own transactions, always resolves anew.

**Performance.** Measured on a document of 5000 elements in 50 frames (a throwaway script, 2026-11-27): `toSnapshot` 110 ms; typing through a binding 0.03 ms per character, work recording included; a move 0.03 ms; reparent, restack and group about 12 ms; deleting a frame with 100 children 40 ms, redoing that delete 23 ms; tidy up 280 ms. Delete marks that are in the document cost nothing per transaction (a test holds a mark of 3000 entries and checks that typing stays fast). Without a live resolver, the reference operations resolve the document anew for each operation, reading only what they need (one element and its ancestors for a move; the children of one or two containers for an insertion; everything for a delete). Creating 5000 elements one operation at a time takes about 9 s that way, so bulk creation (import) should build a fragment and paste it, which resolves once.

Keeping the live resolver up to date, measured in the same document (a test in `ydoc/live.test.ts`, 300 moves each, time spent in the live resolver for the batch of the move and its recording, 2026-11-27, Node 26 on the development machine): moving an element 0.03 ms (median; 95th percentile 0.06 ms); moving a frame with its 99 elements 0.2 ms (median; 95th percentile 0.4 ms). The test fails above 1 ms (median). Building it for the whole document takes one full resolution.

New production dependencies (licenses compatible with GPL-3.0-or-later; versions at least two weeks old on 2026-11-26):

| Package                                                                  | Version | Published  | License | Why                                             |
| ------------------------------------------------------------------------ | ------- | ---------- | ------- | ----------------------------------------------- |
| [yjs](https://www.npmjs.com/package/yjs)                                 | 13.6.33 | 2026-09-23 | MIT     | The CRDT the plan chose for the document model. |
| [lib0](https://www.npmjs.com/package/lib0) (via yjs)                     | 0.2.120 | 2026-11-09 | MIT     | Yjs's utility library.                          |
| [isomorphic.js](https://www.npmjs.com/package/isomorphic.js) (via lib0)  | 0.2.5   | 2022       | MIT     | Random numbers and crypto across platforms.     |
| [fractional-indexing](https://www.npmjs.com/package/fractional-indexing) | 4.0.0   | 2026-06-25 | CC0-1.0 | Order key generation (section 4).               |
| [fflate](https://www.npmjs.com/package/fflate)                           | 0.8.3   | 2026-05-16 | MIT     | Deflate and inflate (section 9.8).              |

## 12. Assumptions

1. Yjs's update format 1 stays readable by future Yjs versions, and Galatsa uses it everywhere. If not, `document.json` still opens every file; only merge identity is lost.
2. Yjs resolves concurrent writes to the same map key the same way on every replica, a concurrent set beats a delete of the same key, and deleting items creates no new items. The tests check the outcomes that depend on it.
3. No more than a few hundred thousand elements per document.
4. Containers never need rotation or scale.
5. A file is read whole into memory, and written from memory; streaming, and with it files over 4 GiB, is future work.
6. Users who want unbounded deep zoom do it inside frames.
7. Every `Y.Doc` a user edits has the work tracker attached before the first edit (section 5.5). An edit made on a document without it is not recorded as work and loses against a concurrent delete.
8. Writer keys (66 random bits per editing session) and action ids (128 bits) never collide, and neither do two different revisions of one record in the 96 bits of their digests. A collision could let a concurrent edit go unnoticed by a delete.
9. Replicas deliver each other's updates completely, and each client's updates in the order they were made, as Yjs does. The updates of different clients may arrive in any order (section 5.5, "Delivery order").

## 13. Open questions and known limitations

1. **Live migrations.** Once there is a sync server, a shared document on it may need an incompatible migration while clients are connected. Running it once on the server, raising the minimum reader version (section 9.4) and resetting the lineage (old clients must reload) is likely, but undecided.
2. **Re-keying against a concurrent insert.** A list is re-keyed when a key in it reaches 128 characters (section 4.1), which takes several hundred insertions at one spot. An item that another user inserts into or moves within the same list at the same time keeps the key it was given among the old keys, and can end up at another place in the list. Nothing is lost.
3. **Revisions grow with sessions.** A record keeps one small entry (about 35 bytes in the Yjs state, 20 in JSON) for every editing session that ever worked on it, and nobody but that session can safely remove it. A document edited in hundreds of sessions that each touch hundreds of elements carries megabytes of them. (Delete marks do not grow with them: a mark holds a digest of fixed size.) Compacting them is possible only when no copy is offline (it would make offline deletes ineffective and could hide offline work from a later delete); a command for that, with that warning, is future work.
4. **Place markers stay.** Each frame or group that is removed and tidied leaves an empty marker (about 350 bytes of JSON, with the mark that removed it) until the document's merge identity is reset. The same future command could drop them.
5. **A delete lists everything it hides, and marks stay.** Deleting a frame with 5000 elements writes one mark of about 200 kB. Tidy up shortens a mark by the records it deletes but does not remove it (section 5.8); a mark goes away when its record is restored or is deleted from the document by a tidy up, and a mark that hides nothing when a replica that holds it works on the record. A mark on a frame or group that became a place marker therefore stays, with the entries of the place markers inside it.
6. **The instant between a change and its recording** (section 5.5): a delete made by a replica that has received a change but not yet its new revision does not take effect and has to be repeated. Nothing is lost. Writing both in one transaction is not possible without undo restoring old revisions.
7. **Work done knowingly on a deleted record is not recorded.** If it is later restored, and a third user who saw neither the work nor the first delete deletes it concurrently, that delete hides the work. This needs an undo or redo of an old edit on something the user sees as deleted, a restore, and a third party's concurrent delete.
8. **Restoring one element out of a deleted container** is done by declaring work on it (`noteWork` with `evenIfDeleted`). Yjs's undo cannot undo that; the element has to be deleted again. No reference operation or interface for a "bin" exists yet.
9. **Redo after a filled hole** (settled with the basic commands): a filled hole is now part of the undo step (section 10), so a following redo changes that key again.
10. **Replacing shared types.** Setting a data key to a new shared type discards concurrent edits inside the old one, and Yjs's undo restores the old value without edits made after it was replaced. Extensions should create their shared types with the element (section 3.4, pattern 8).
11. **What Yjs cannot carry.** Object keys named `__proto__` inside plain values, node attributes of that name, and anything JSON cannot express inside text embeds and formatting attributes, are not supported (section 3.4); the JSON form leaves them out on every replica, so replicas agree, but the value is not what its author wrote. A big integer inside a text embed or formatting attribute cannot be encoded by Yjs at all: such a state cannot be synced, and the writer saves it without `ydoc.bin` (with a warning).
12. **Hostile depth inside Yjs.** Yjs deletes and garbage-collects nested shared types by recursion. Galatsa's own code is bounded (section 9.7) and tidy up empties very deep structures level by level, but replacing or deleting a value that a faulty peer nested thousands of levels deep through other paths (an operation that overwrites it, or Yjs applying a peer's delete of it) can overflow the stack inside Yjs.
13. **A damaged manifest** makes a file unreadable although `document.json` may be intact; reading the versions from the document instead is possible future hardening.
14. **Media type.** `application/vnd.galatsa.presentation+zip` is not registered with IANA.
15. **Repair writes.** Resolution never writes; stale state (rebases, cycle breakers, gone containers with children) stays. Whether the editor should normalize some of it is open; writing positions outside a move would reintroduce the conflict of section 5.3.
16. **Mixed double conflicts.** Rule 3 of section 5.3 uses container offsets from rules 1 and 2; if a container is itself in a rule-3 state (two overlapping conflicting container changes), positions inside it are approximate (not lost, possibly slightly off). The property test finds no failure of its invariants, but does not measure this. The same goes for a position converted by rule 3 when a change of container (also an undone one, finished to keep every container's place, section 10) alters the containers it is converted through: it is converted through offsets computed by rules 1 and 2 alone, which such a change can alter even though no container moves on the canvas.
17. **Performance of the reference operations** (section 11): with the document's live resolver, an operation reads the resolution that is kept up to date; without it, one resolution per operation. Operations that write and then read again inside their own transaction (grouping places the members after creating the group) still resolve anew there. The live resolver itself costs a full resolution to build, and memory for what it caches of every element; a change that reaches many elements (moving or deleting a container with thousands of elements) costs in proportion to them. The bounds of a group are computed by going through all its members whenever one of them changes: moving an element inside a group of 5000 takes about 1.8 ms, and inside ten nested groups of 500 about 15 ms (measured in review, 2026-11-27). Keeping group bounds incrementally is future work.
18. **Deleted content in a running session.** Within a session, Yjs keeps the content of what the user deleted for as long as the undo history can bring it back, and sends it to the replicas the session syncs with (which drop it on arrival). Files never hold it (section 5.8). A sync server that must not see deleted text needs the client to send from the garbage-collected state; that is for the sync package to decide.
19. **Asset descriptions and a concurrent tidy up.** A use of an asset that is written without `addAsset` (by an extension that sets an asset id directly) does not protect the description against a tidy up made elsewhere at the same time; the asset is then reported as not described (section 8.3) and its bytes are kept.
20. **No zip64.** Files end at 4 GiB (section 9.1); larger media has to be kept next to the presentation (section 8.4).
21. **Commands inside one Yjs transaction.** An operation that creates records throws inside another transaction (section 10). Command code has to use the undo manager's `group`, which the command layer should wrap once.
22. **Reordering a route and a removed stop.** Inserting a visit counts as working on the stop and keeps it; reordering does not (decided with the users). Whether removing a stop should warn when routes still visit it was a question for the editor; the users decided that deleting a stop that routes use warns ("used in N routes") and lets the user choose, and that a stop deleted anyway disappears from all the routes ([0013](0013-routes-and-stops.md)).
23. **Stacking after an undone change of container.** An undo that takes elements out of a container puts back their old order keys. If another user restacked the container since (brought a group to front), the undo keeps the members where that user's move put them on the canvas (section 10), but not in front: they go back to their old places in the stacking order, where an ungrouping would leave them in front.
24. **Cost of an undo that changes a container.** One pass over all elements with two resolutions of the document: 55 to 105 ms with 5000 elements in 50 frames (measured 2026-11-27). The live resolver could narrow the pass to what the step affects.
25. **An older undo after a held-back one.** When an undo is held back because it would bring back what another user deleted, and that user then restores it, a later undo of an older step of the same element finds the held-back values as newer writes; Yjs refuses to put the keys back, treats the step as empty and goes on to the next one. One press of undo then undoes a different, older step than the user expects. Nothing is lost (redo brings it back). Possible remedy: link the undo's restored item to the held-back write, as is done for delete marks.
26. **Several nested containers changed in one step.** If one step takes both an element and its container out of a frame (possible through the core operations or a composite command, not through the built-in commands), and another user moved the frame meanwhile, undoing the step keeps the container's place but shifts the element by that move, because its new position is computed before the container's. Remedy: write the new positions from the top down.
27. **An undo that ends a cycle.** When two users concurrently put two frames into each other, one of them is shown at the root (section 5.4). If one user then undoes their part, the other frame goes back inside, and if it was moved meanwhile it jumps by that move with everything in it. Keeping its place would mean writing a position on a record the undo did not touch.
28. **An undo concurrent with another user's move.** If A undoes a grouping while B, not yet aware of it, moves the group, the members stay where they were before B's move; an ungrouping concurrent with a move keeps the move (section 5.7). The concurrency test checks each undo only against changes already received.

Items 25 to 28 matter only when users edit the same elements at the same time, and are left for the work on synchronisation.

## 14. Rejected alternatives

- **A `Y.Array` of child ids per container.** Concurrent moves duplicate or lose elements.
- **Absolute (world) positions.** Moving a frame would rewrite every child; concurrent additions would be left behind; precision is wasted.
- **Reparent rewrites `pos`.** The first version of this design. A concurrent move and reparent then write the same key and one is lost depending on client ids. The rebase keeps both.
- **One rebase translation from the stored position's space only.** Also tried first: a move written in the space of a pending rebase (after grouping) fell back to rule 3 and the element then followed its old group. Recording a shift for every space the element was in fixes it, including chains.
- **Rewriting `pos` when an element returns to the space its position was written in.** Lost a concurrent move for one client order; `base` replaces it.
- **One atomic placement value (parent, order, position).** A concurrent move and reparent would lose one change entirely.
- **Hard delete.** Loses concurrent edits; undo cannot restore them.
- **Delete wins (first version).** A deleted container hid everything in it, including what others added or edited concurrently. The users decided that concurrent work survives (section 5.5).
- **A delete mark on every element the delete covers, each checked against its own revision and the deleted root's (second version).** Work on a container in between was not on the path that was checked, so moving a group inside a deleted frame kept the group and deleted its members. Two users' marks on the same element overwrote each other, so which delete survived an undo depended on client ids. One mark per delete on the deleted record, listing what it saw, and the path rule fix both.
- **One revision token per record, rewritten by every change (second version).** Two concurrent writes of one key collapse into one: if the token a deleter had seen won against the token of a concurrent edit by a third user, the edit went unnoticed and was deleted, depending on client ids. Hence one entry per writer.
- **A new item per unit of work (a token, or a counter value).** Correct, but every keystroke and every step of a drag then creates an item that sits between the user's own items in the client's sequence, and Yjs can no longer merge typed text into runs or collapse overwritten values: about twenty times the state for text. A writer shortening its own array creates no items.
- **Recording work in the operations (second version).** Every operation, and every extension and editor binding, had to remember to mark the records it changed; typing through an editor binding did not, and lost against a concurrent delete. The tracker sees every local transaction.
- **Comparing content instead of revisions** (a delete lists a hash of what it saw). No bookkeeping at all, but every later change of the JSON form, even a new default, would change the hashes and bring deleted things back.
- **Yjs's state vector in the delete mark.** Does not see deletions inside a record (removed text), is not available in the JSON form, and grows with the number of sessions in every mark.
- **Writing the new revision in the same transaction as the change.** Undo would then put the old revision back, which makes an earlier delete apply again or a later one stop applying.
- **A copy of the revisions in every delete mark (third version).** A mark then grew with the number of sessions that ever worked on each record it lists, a document's marks with sessions times elements, and every local transaction read them all again. A digest has a fixed size, and what a mark lists is read once.
- **Declaring a visit as work in the operation that inserts it (third version).** Redoing "add visit", undoing "remove visit" and duplicating a route create visits without that operation, so a stop removed elsewhere at the same time was lost against them. The tracker now finds every new visit itself.
- **Tidy up removing marks that hide nothing (third version).** With the changes of different users arriving in any order, such a mark may list work that has not arrived yet; removing it brought a deleted element back for good.
- **Place markers as dissolved containers (third version).** Undoing "remove frame, keep contents" after a tidy up took the dissolve back and showed an emptied frame. A marker now has a flag of its own that nothing undoes.
- **`minReaderVersion` as a plain value, last writer wins.** A client that had not seen a raise could lower it again by writing the old value. Raising by adding keys cannot be undone by any write.
- **Creating a record in whatever transaction the caller has open.** The untracked first step of a creation (section 10) merged into the caller's transaction, and undo then deleted the record for good, with what others had put into it. Refused instead.
- **References as an array, last writer wins.** Two users who each attached something to the same element lost one attachment. A set keeps both.
- **Refusing a file when anything in `document.json` is invalid (second version).** One odd value, written by a normal operation or by a peer, made a file that saved without error impossible to open. Hence one grammar and quarantine.
- **Refusing `ydoc.bin` when it holds anything its JSON form lacks (second version).** One unknown key from one peer cost every user their merge identity on every reopen, which strands offline work. It is kept and reported instead; exports for sharing carry only the JSON form.
- **Tidy up that moves survivors out of removed containers and rewrites their positions (second version).** Its writes conflicted with offline moves, and content added offline to a purged container had lost its frame of reference and jumped. Place markers and no rewrites keep both in place.
- **Ungroup by moving the children out.** Loses children added concurrently and a concurrent move of the group.
- **Purging removed records by age.** Long-offline copies could no longer merge (decided with the users: purge only on request and in exports for sharing).
- **Preserving unknown archive entries and manifest fields.** An older version would write back entries that no longer match the document it changed. They are dropped, and what must survive raises the minimum reader version.
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
- **Accepting any zip archive.** An archive comment, or bytes between entries, can hold a second archive that another reader would find instead. The strict subset has one reading.
- **A limit on the total declared size of all entries (second version).** The default of 4 GiB was more than a reader can allocate, and it counted stored media that need not be copied at all.
- **Throwing on values JSON cannot express.** One value from a peer made a whole document unsaveable.
- **fflate's `zipSync` for writing (third version).** It does not check the 4 GiB limit: offsets and sizes wrap around and the file cannot be read by anything. The writer is 100 lines of own code and refuses.
- **Compressing assets by media type (third version).** Compressed entries count against the reader's memory limit, so two large uncompressed images made a file its own writer's reader refused. Stored assets cost no memory and little space, since most media is compressed already.
- **Zip64 in version 1.** No reader that holds the file in one buffer could open such a file (section 9.1).
- **Tolerant zip reading (local headers not compared, sizes after the data accepted).** Two readers can then see different contents in one file.
- **Migrating element data on load.** Every extension upgrade would cut a file off from other users' offline copies.

## 15. Tests

All tests run with `pnpm check` (Vitest). Concurrency tests use replicas that start from the same state, change independently, then exchange updates (`Y.encodeStateAsUpdate` against the other's state vector), and check that all replicas end with equal JSON forms and the outcome specified above, with the client ids in both orders.

- `packages/core/src/ydoc/merge-elements.test.ts`: for each element type (frame, group, text, shape, image, freehand, table, chart, map, media), two concurrent edits of different parts both survive, and a same-key conflict converges.
- `packages/core/src/ydoc/merge-structure.test.ts`: rows of the tables in sections 4.3, 5.7 and 6.5.
- `packages/core/src/ydoc/undo-settle.test.ts`: an undo or redo of a move into a frame, or of a grouping, after receiving another user's delete leaves what the delete hid deleted; a hole is filled within the undo, before it is judged (the element is back in its frame, and stays deleted), and a redo puts the filled value back too (both client orders); the user's own delete is still undone; undoing a grouping after another user moved the group leaves the members where that move put them; an undone change of container after another user's move is done, keeping the place: undoing the creation of the frame next keeps an element that was put into it, an undone move out of a frame puts the element back in it where it is, undo and redo go on working after the other user takes their move back, and an older undo of the same element still works; a third user's concurrent move of an element whose undo is held back survives (where it ends is Yjs's choice between the two writes, the same on every replica); the live resolver stays equal to a fresh one; without concurrent changes, an undone move into a frame moves the element back. The random two-user test of the basic commands (`packages/extensions/basics/src/concurrent.test.ts`, docs/adr/0005 section 12.1) checks the same rules on every undo and redo, and that the user's own undo is done.
- `packages/core/src/ydoc/regressions.test.ts`: the defects found in the first review: rebase chains and returns, lineage refusal, lossless round trip of every odd value, undo of grouping and of creation with concurrent work, precision of operations far from the origin, operations on children of gone containers, moves with late-arriving parents, tidy up and export purging, paste with reference remapping.
- `packages/core/src/ydoc/review2.test.ts`: the defects found in the second review and the rows of section 5.7 added since: the path rule (moved group, moved subframe, ungroup and deep edit inside a deleted frame), two deletes of one frame, a concurrent edit that a single revision token lost, typing through an editor binding into elements and speaker notes, visits and reorders against removed stops and routes, undo against deletes in both directions, redo of a delete after edits, undo of a creation after edits, merged undo steps, undo covering binding origins, undo that Yjs leaves half done, place markers after tidy up, operations refusing invalid arguments, a snapshot that is valid whatever a peer wrote, deep nesting, equal JSON forms on author and peer, `__proto__` keys, paste order, three-way reparent, the version gate, a blank replica, and import as a copy.
- `packages/core/src/ydoc/review3.test.ts`: the defects found in the third review: marks of fixed size whatever the history, and no cost per transaction; a stop kept by a redone, restored or duplicated visit; restore and undo of a delete against an older delete that arrives later; an undo that finds a mark someone else put back; tidy up against a concurrent duplicate that needs an asset description, against unknown root types, against an undo of "remove frame, keep contents", and against a mark whose work arrives later; creation refused inside a transaction and `group` as one undo step; import as a copy with frame stops whose frame is gone, and with the routes' playing order; versions that only rise; a blank replica refused; long order keys re-keyed; references as a set; an independent copy.
- `packages/core/src/ydoc/property.test.ts` with `scenario.ts`: for random documents, three replicas apply 80 random steps each run (all reference operations on elements, stops and routes, typing through an editor binding's own transactions, duplicate, commands of several operations in one undo step, a delete that is redone after another user removed the same container, undo, redo, tidy up, import as a copy, full and one-way syncs), then sync fully. **The scenario has a model of its own**, which shares no code with the resolver or the tracker: its own computation of the tree (parents, cycles, gone containers), and for every record the set of units of work done on it, with what each replica has received of them. It has no revisions. For each mark it remembers what the writer saw: which records, and which work on each. After every step and every sync it computes from this, for the replicas involved, which elements, stops and routes must be hidden, and compares with what the implementation says, **in both directions**: nothing is hidden that should be visible (work survives), and nothing is visible that should be hidden (a delete deletes). It also checks what each new mark lists against what the model says the user saw. Further checks: the replicas converge; every snapshot is valid and survives a round trip through a new document; the documents hold nothing the grammar has no place for; no step throws; the drawing order is sane; an export purge and a tidy up change nothing the user sees and nothing a route plays, and a tidy up rewrites nothing it keeps; an import as a copy shows what the source showed. Two more properties run on random junk, written by a peer into the Y.Doc or found in a document's JSON: reading is total, valid, stable, at most 256 levels deep and the same on every replica, resolution and tidy up work on it, and the document survives a round trip. 40 seeds by default; `GALATSA_FUZZ_SEEDS` (with `GALATSA_FUZZ_FIRST` and `GALATSA_FUZZ_STEPS`) for a long run. The tests were themselves tested by mutation: 41 deliberate defects were put into the resolver, the tracker, tidy up, the operations and the file code one at a time (a delete that hides too much or too little, work not recorded or recorded where it must not be, marks not refreshed, a visit that is not work, a restore that is not work, tidy up that rewrites or removes too much, a writer that compresses assets or does not check sizes, a reader that does not compare headers, and so on). 40 were caught, each of the five the third review named for the scenario (work always recorded, a mark listing survivors of a gone container, marks not refreshed, a delete that hides nothing, children never hidden) by the scenario with its default seeds. The one not caught changes no result: the writer checks the size twice, before and after compressing, and without the first check the second refuses the same files.
- The live resolver (section 11): `property.test.ts` checks every replica's live resolver after every batch of transactions of the scenarios against a new resolution of the whole document, and that it reported every element and container whose answers or record changed (`ydoc/live-check.ts`). `packages/core/src/model/live.test.ts` does the same on random states with parent cycles, missing parents, converted positions, pending rebases and delete marks, changed one to three keys at a time; removing any one dependency rule, or forgetting a broken cycle in part, makes it fail. `packages/core/src/ydoc/live.test.ts`: local changes, recording of work not reported, a parent that arrives after its child, a cycle with a converted position, undo, redo, tidy up, loading, when the operations use it, detaching, work recorded in a follow-up transaction that brings back what a delete hid, a listener that writes a cycle while a transaction ends, a transaction that throws half way, a subscriber that throws, other listeners that throw, batches that bring many elements at once (nested groups by sync, a deleted frame by loading, a paste) without a false alarm and with new elements reported as added, a removal and additions in one batch, reports relative to the state before the batch when it resolves anew, a subscriber that writes, and the time an update takes in 5000 elements in 50 frames. `ydoc/live-follow-up.test.ts`: random operations while other listeners and a deep observer write follow-up transactions into the same batch and read the live resolver in the middle of it (40 seeds by default). `model/live.test.ts` also: an update that fails half way, a loop in the cached parents and in the cached children, and error handlers that throw.
- `packages/core/src/ydoc/encode.test.ts`: the generic encoding round-trips every shared type, the escape and any trees.
- `packages/core/src/model/model.test.ts`: order keys and their syntax, ids, zoom clamp, SHA-256 against its published test vectors and one pinned revision digest, resolution (orphans, cycles, the three position rules, the path rule for deletes, what a delete lists, trees 30 000 deep), routes and show/hide, stop regions, and the grammar: what is reported, what junk reads as, that reading the result changes nothing, restoring unsupported values, nesting depth, external media.
- `packages/format/src/zip.test.ts`: CRC-32, order, deterministic output, unsafe and duplicate names, truncation, corruption, limits, zip64 refusal, overlapping entries, lying sizes stopped early, local/central name mismatch, skipped unknown entries.
- `packages/format/src/file.test.ts`: round trip with equal document and bytes; archive and manifest layout; unknown extensions with and without `ydoc.bin`; merge identity across a reopened file; assets kept while soft-deleted and dropped in exports for sharing; migrations (with a test registry, since version 1 is the first); compatible newer files keep their additions; too-new files are refused; damage codes and recovery from `ydoc.bin`; asset hashes; `ydoc.bin` discarded when it disagrees, is not described by the manifest, has another lineage or is too large; content the format has no place for reported and absent from sharing exports; assets referenced from settings, transitions and embeds; absurdly deep nesting opened and cut.
- `packages/format/src/review2.test.ts`: every odd value a peer can write still gives a file that opens equal with both readers, with and without `ydoc.bin`; `__proto__` keys in files; a file written without `ydoc.bin` when Yjs cannot encode; quarantine per record and value with the list the user gets; unknown kinds of values kept and written back; open slots on assets, route entries, stop views and visibility changes; damaged asset and `ydoc.bin` entries; unknown archive entries and manifest fields; the version gate in the writer and reader; every form of zip64; archive comments, hidden archives and trailing bytes; the memory bound.
- `packages/format/src/review3.test.ts`: the writer refuses a file over the size limit and over the entry limit instead of wrapping around (and, when `GALATSA_HEAVY=1` is set, writes a real archive of 3.5 GiB and refuses one of 4.4 GiB); assets are stored whatever their media type, and a file with more uncompressed media than the reader's limit for decompressed data opens; a document or state over the writer's limits; local headers that differ from the directory in checksum, sizes, method or flags; sizes after the data; a `ydoc.bin` that needs a newer reader than the manifest says; versions never lowered by the reader; no deleted text in a saved file; an asset that nothing describes.
- `packages/format/src/property.test.ts`: on the random scenarios and the random junk of core's tests, every file written at any moment reads back as the same document with its merge identity, by both readers; an export for sharing shows the same and holds only what is visible; a reopened file still syncs with the other replicas. 15 seeds by default.
