# 0006 Storage: autosave, the last good copy and recovery after a crash

- **Status:** Accepted
- **Date:** 2026-11-27

## Contents

1. [Context and summary](#1-context-and-summary)
2. [What has to hold](#2-what-has-to-hold)
3. [Backends](#3-backends)
4. [What is stored, and when](#4-what-is-stored-and-when)
5. [Sessions, tabs and recovery](#5-sessions-tabs-and-recovery)
6. [The user's files](#6-the-users-files)
7. [What the user is told](#7-what-the-user-is-told)
8. [Work tracking and the live resolver](#8-work-tracking-and-the-live-resolver)
9. [The interface for the editor](#9-the-interface-for-the-editor)
10. [Tests](#10-tests)
11. [Known limitations and open questions](#11-known-limitations-and-open-questions)
12. [Rejected alternatives](#12-rejected-alternatives)

## 1. Context and summary

The file format ([0001](0001-document-model-and-file-format.md), section 9) says how a document is written to and read from a `.galatsa` file, and leaves "recovering the last good version after an interrupted save" to the saving code. This note describes that code: `packages/storage` (`@galatsa/storage`), the layer between the editor and the files. Its one purpose is that the user never loses work: not to a crash, not to a save that is cut short, not to a damaged copy, and not to a second tab with the same document.

| Topic              | Decision                                                                                                                                                                                                           | Section |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Where              | A small key-value store of byte arrays behind an interface (`StorageBackend`). IndexedDB in browsers, memory for tests; the desktop file system later, with the same guarantees.                                   | 3       |
| Autosave           | Every change goes into a **journal** of Yjs updates 0.3 to 1 second after it is made. Now and then the journal is folded into a **checkpoint**: the whole document as a Galatsa file without assets.               | 4       |
| Assets             | Stored once each, by content address, apart from checkpoints, so checkpoints stay small however many images a document has.                                                                                        | 4.4     |
| Last good copy     | The checkpoint before the newest one is kept, with the journal since it. Every stored record carries a length and a checksum; a damaged one is never used, and the copy before it plus the journal take its place. | 4.5     |
| Concurrent writers | Each session writes journal entries under keys of its own. A checkpoint is created only if its generation number is free (an atomic "create if absent"), after merging what the others stored. Yjs merges.         | 4.5, 5  |
| Recovery           | Each session leaves a record while it runs. At the next start, records of sessions that stopped without closing and had unsaved changes are offered for recovery.                                                  | 5       |
| User's files       | Saved through a `FileTarget` that replaces the file atomically (File System Access API, or a download as fallback), then read back and compared.                                                                   | 6       |
| Messages           | Every outcome is a `Notice` with a code; each code has a message in Norwegian Bokmål and English in the namespace `storage`.                                                                                       | 7       |
| Work tracking      | The layer attaches the work tracker to every document it hands out, before anyone can change it.                                                                                                                   | 8       |

## 2. What has to hold

1. A crash loses at most the last second of work.
2. Autosave never makes editing stutter, also for large documents with many images.
3. A write that fails or is cut short never damages what was stored before.
4. When a stored copy or a file cannot be read, the user gets a message they can understand, and is offered the last good copy.
5. After a crash, the next start offers the unsaved work.
6. Two tabs or windows with the same document never overwrite each other's work.
7. All text the user sees comes from the translation files ([0003](0003-translations.md)).
8. It works without network and without an account, like the rest of Galatsa.

## 3. Backends

```ts
interface StorageBackend {
  read(key): Promise<Uint8Array | undefined>;
  list(prefix): Promise<string[]>; // sorted by UTF-16 code units
  write(key, bytes): Promise<void>; // atomic replace
  create(key, bytes): Promise<boolean>; // atomic create-if-absent
  remove(keys): Promise<void>;
}
```

Keys are short ASCII paths (`[a-z0-9_.-]` segments joined by `/`), so that a file system backend can map them to files. The layer relies on exactly three guarantees:

- `write` is atomic per key: a reader sees the old bytes or the new ones, never a mix, also when the program stops in the middle.
- `create` checks that the key is absent and writes in one atomic step, and returns false (changing nothing) if it is present.
- A write that has resolved is durable, as far as the platform allows.

Nothing is atomic across keys. The layer orders its writes so that a stop between any two of them leaves only redundant data (section 4.6).

| Backend             | `write`                                                          | `create`                                                                     | Status                      |
| ------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------- |
| IndexedDB           | `put` in a read-write transaction, durability `strict`           | `count` and `add` in one read-write transaction                              | Built (`indexedDbBackend`)  |
| Memory              | a map; can simulate failed, torn and stopped writes              | the same                                                                     | Built (`createMemoryStore`) |
| Desktop file system | temporary file, flush, rename over the old one, flush the folder | temporary file, then a hard link to the final name, which fails if it exists | Later, with the desktop app |

The IndexedDB backend asks for `strict` durability, a hint that the browser flushes to disk before the transaction completes, where the browser supports the hint (from memory; the effect was not measured). Browsers may evict a site's storage under pressure; `requestPersistentStorage()` asks the browser to keep it, and the program should call it once the user has a document worth keeping (some browsers ask the user).

The IndexedDB backend opens a new connection when the browser has closed the old one (a newer version of the database opened elsewhere, or the user cleared the site's data), and runs a transaction that could not start once more on the new connection. Such a transaction wrote nothing, so trying again is safe.

`checkBackendContract` (entry `@galatsa/storage/testing`) checks the guarantees that one program can observe, without a test framework, so the same checks run against memory in Node, against IndexedDB in browsers, and later against the desktop backend.

## 4. What is stored, and when

```
doc/<slot>/info                 the stored document's description (JSON)
doc/<slot>/cp/<generation>      checkpoints (framed Galatsa files)
doc/<slot>/j/<session>-<seq>    journal entries: Yjs updates (framed)
doc/<slot>/a/<asset id>         asset bytes, by content address
doc/<slot>/s/<session>          one record per session that has the document open
```

A _slot_ is one stored document, with a random id. A slot exists once its first checkpoint does. A new slot gets two checkpoints at once (generations 1 and 2, the same document), so that a last good copy exists from the very start.

### 4.1 Frames

Every journal entry and checkpoint is wrapped in a frame: a 20-byte prefix (magic `GLST`, version, kind, the lengths of a JSON header and of the payload, and a CRC-32 of both), the header and the payload. A frame is used only if it is complete to the byte and the checksum matches. A record that is cut short, too long, or has a single changed bit is recognised and skipped (tested at every cut position and for flipped bytes).

### 4.2 Checkpoints

A checkpoint is the whole document as a Galatsa file (0001, section 9) without assets, so it holds both `document.json` and `ydoc.bin`, each with its own checksum, and is read by the same reader as any file. Its header names its generation, the generation it was built on, and the journal entries whose content it holds (`includes`). If the Yjs state is too large for a file (`ydoc-not-written`), the state is kept in the frame next to the file, so the journal still applies to it.

Building the file is the expensive part. Measured on a document of 5000 elements in 50 frames (a throwaway script, Node 26, 2026-11-27): encoding the Yjs state (2.8 MB) takes 30 ms; building the checkpoint file from it 760 ms; reading a checkpoint back 920 ms; the checkpoint is 0.9 MB. So the layer only encodes the Yjs state on the editing thread, and builds the file through a `CheckpointEncoder`, a function of the state's bytes alone. The default runs on the calling thread; `workerEncoder(worker)` sends the work to a module worker running `@galatsa/storage/checkpoint-worker`. A worker that reports an error, sends a message that cannot be read (`messageerror`) or does not answer within 60 seconds is given up for good, and the work is done on the calling thread. The session also gives any encoder a time limit (`checkpointTimeout`, 60 seconds) and then builds the checkpoint itself, so no checkpoint is lost to a worker problem. The first checkpoints of a new slot are always built on the calling thread, so a worker that does not answer cannot keep a document from opening. The editor should use the worker.

Checkpoints are written when editing has paused for 2 seconds and the last checkpoint is at least 30 seconds old (or the journal has grown by 4 MiB since it), and in any case 5 minutes after the first change since the last one; and when a session closes. The timer is armed by the first change after a checkpoint. Every checkpoint, also one from the timer, flushes the journal first, so everything a checkpoint holds is also in a journal entry or in an earlier checkpoint.

Journal entries and checkpoints go through two separate queues. A checkpoint waits for the journal to be flushed, but the journal never waits for a checkpoint: a checkpoint that takes long (or an encoder that hangs) does not stop changes from being stored.

### 4.3 The journal

Every Yjs update a document emits, whatever its origin (the user's operations, an editor binding, undo, the work tracker, a sync provider), is collected, and 0.3 seconds after the last change, but no later than 1 second after the first one not yet stored, the collected updates are merged (`Y.mergeUpdates`) into one entry and written under a new key of the session's own. Updates are small: 30 moves in the document above are 1.7 kB, and merging them takes 0.2 ms. Updates the layer itself brings in (origin `STORAGE_ORIGIN`: other sessions' entries and checkpoints) are not journaled again, because they are stored already.

Why both: writing the whole file on every change would cost most of a second each time (section 4.2), and saving it only every minute would lose up to a minute. Journaling Yjs updates is cheap and incremental, so changes can be stored within a second; checkpoints keep the journal short, so opening stays fast and the journal does not grow without bound. Yjs updates are idempotent and commute, so applying an entry twice, or in another order, gives the same document, which is what makes the protocol below simple.

The browser may close or freeze a tab after hiding it, so a session stores at once when its page is hidden or left (`visibilitychange`, `pagehide`). This is best effort: the browser may stop the page before the write completes.

### 4.4 Assets

An asset's bytes are written once, by content address (`create`, so a second copy of the same image costs nothing), when the editor adds it (`session.putAsset(bytes)`, which returns the id the document then describes with `addAsset`). Reading checks the bytes against the id; damaged bytes read as missing. Checkpoints never contain assets. Saving to a file reads the assets the document refers to (0001, section 8.3) and writes them into the file.

Assets are not removed while a slot exists, because undo and recovery can bring back an element that refers to one; they go when the slot is deleted.

A session also keeps in memory the bytes of every asset it has stored, read, or opened from a file. If the store cannot be read, saving to a file uses them (section 6), and assets the store could not take are written to it later.

### 4.5 The checkpoint protocol and the last good copy

A session knows the generation its document is based on (its _base_) and every journal entry its document holds. To write a checkpoint it:

1. flushes its journal;
2. lists the checkpoints; if there is a newer one than its base, merges the newest one that reads (walking down past damaged ones), and takes it as its base;
3. reads every journal entry it does not hold yet and merges it;
4. encodes the state, and notes, at the same moment, the entries it holds;
5. builds the file and **creates** the key of generation (newest + 1); if the key exists (another session was quicker), it starts again from 2;
6. reads the checkpoint back and compares it with what it wrote; if they differ, it removes nothing and reports the store as failing;
7. removes every older checkpoint except its base, the journal entries its base holds, and the damaged journal entries it found.

A session that listed long ago can create a generation number that others have since passed and removed (the key is free again). Such a checkpoint is older than the newest one, and harmless: loaders take the newest that reads, every later checkpoint holds its base, and the next writer removes it. An earlier version of the protocol had a step that took it back; it is not needed and was removed.

What stays is the newest checkpoint, the one before it (the base, the _last good copy_), and the journal entries since the base. Every checkpoint holds its base (step 2), the base and the journal since it hold everything the newest one holds (step 1), and an entry is removed only once two checkpoints hold it. So:

- if the newest checkpoint is damaged, the one before it and the journal since it give the same document, and nothing is lost;
- two sessions can never both write generation _n_ (step 5), and the one that loses merges the winner's checkpoint before it tries again, so neither overwrites the other's work;
- a session removes only entries and checkpoints that two later checkpoints already hold.

**Damaged journal entries.** An entry that is damaged is never taken as held: it is noted, and removed after the next checkpoint, because it holds nothing that can be used. Updates that build on it (the same session's later entries, or another tab's work on top of it) cannot be applied, and Yjs holds them back as _pending_. Yjs would carry pending updates into every encoded state, and a state with pending updates is not a complete document: the file reader rejects it, so every later checkpoint would lose its merge identity. The layer therefore drops pending updates (`dropPending`) after it has brought in what the store holds. What it drops is still in the journal entries it came from, but only until the next checkpoint, which removes those entries as held; after that it survives only in the checkpoints of a session that had what it builds on.

`dropPending` clears every pending update of the whole document, whatever brought it. Today only stored entries can leave pending updates (the channel and the journal deliver every entry, in order, from the time a session opens). A sync provider (later) delivers updates out of order as a matter of course, and its pending updates would be dropped at every checkpoint and every save to a file. Before sync is added, `dropPending` must be changed to drop only what the store brought in (for example by applying stored entries to a scratch document first).

**Opening** a slot takes the newest checkpoint that reads and whose Yjs state is usable, and applies every intact journal entry it does not hold. A damaged checkpoint gives the notice `restored-previous-copy`; damaged entries `changes-lost` (with how many entries); changes that depend on a lost one are dropped and give `changes-incomplete`. When something was damaged, a new checkpoint is written at once, and the damaged entries go with it, so the notices come once, not at every opening. If no checkpoint reads, the slot cannot be opened (`stored-damaged`); if the only one that reads has an unusable Yjs state, the document is opened from its `document.json` without the journal, and the user is told how many changes were lost.

### 4.6 A stop at every point

| The program stops...                        | What is stored                                            | What the next start does                                                                             |
| ------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| before a journal entry is written           | the entries before it                                     | opens without the last second of changes                                                             |
| while a journal entry is written            | IndexedDB: nothing of it. A non-atomic store: a cut entry | skips the cut entry (`changes-lost`), as above                                                       |
| while a checkpoint is created               | the old checkpoints and the whole journal                 | uses the previous checkpoint and the journal (`restored-previous-copy` if a cut checkpoint was left) |
| between creating a checkpoint and removing  | old checkpoints and entries that are held twice           | uses the newest; the next checkpoint removes the rest                                                |
| while saving to the user's file             | the store has everything; the file is unchanged           | offers the work; the file opens as before                                                            |
| before a new slot's checkpoints are written | nothing of the slot, or one checkpoint                    | the session writes a whole checkpoint before any journal entry, once the store takes it              |

The memory backend can tear a write at any byte and stop its program, and the tests do so at many positions (section 10).

## 5. Sessions, tabs and recovery

A _session_ is one open document in one program (tab, window). It has a random id; its document has a Yjs client id of its own and a work tracker of its own, so each session is a separate writer (0001, section 5.5). While it runs it keeps a record (`doc/<slot>/s/<session>`) saying when it started, when it last stored a change (updated at most every 10 seconds), and whether it has changes not saved to the user's file. A clean `close()` flushes, writes a checkpoint and removes the record. A record that stays behind means the session stopped without closing.

**Running or stopped.** A running session holds a Web Lock named after it, which the browser releases when the tab closes or crashes; `navigator.locks.query()` then tells running sessions from stopped ones, in any tab or window of the same site. The lock is taken before the record is written, so no other program can see the record of a session that does not yet hold its lock. Every session also writes a heartbeat into its record every 30 seconds. Where the Web Locks API is missing, or asking it fails, the heartbeats decide: a session without one for 2 minutes counts as stopped (background tabs may run timers only once a minute, so the margin is wide). A record that cannot be read counts as running. Whether a session counts as stopped decides what is offered and what may be deleted; it never decides what is written.

A frozen tab writes no heartbeats and may count as stopped. If its document is offered and opened elsewhere, the two sessions merge as two tabs do. If its document is deleted meanwhile and the tab comes back, its next checkpoint finds no checkpoint and writes the whole document again as generation 1: the document comes back, but without the asset bytes, which went with the deletion (the session still holds those it has seen in memory, and a save to a file includes them).

**Recovery.** `recoverable()` lists the slots that have records of stopped sessions with unsaved changes. Opening the slot restores the work (journal and checkpoints are per slot, not per session, so all of it is there) and removes those records. `dismiss(slot)` stops offering it for good and keeps the document, with the restored work, in `list()`. `discardChanges(slot, file)` drops the changes of a document that has been saved to a file: it opens the file first, as a new stored document, and removes the old stored copy only once the file has opened, so a file that was moved, lost or damaged never costs the last good copies. For a document that was never saved to a file (a download does not count) it does nothing and answers `"no-file"`, because that would delete the whole presentation. `dismiss` keeps, in the document's description, the time of the last change the stopped sessions recorded, so a document with changes not in its file never opens as saved. `deleteDocument(slot)` deletes a stored document altogether. Both refuse while a session has the document open, or while that cannot be told. Records of stopped sessions without unsaved changes are removed quietly.

**Opening while another program deletes.** If one program deletes a document while another opens it, the opener may find no checkpoint after it has written its record; it then writes a whole checkpoint before any journal entry. If the deletion falls after that check and the opener stops before its next checkpoint, the changes made in that window are lost, in a document the user chose to delete; so are the document's asset bytes, which the deletion removed (the opener keeps those it has seen in memory). This is accepted.

**Several tabs.** Two tabs may have the same slot open; they are two sessions writing to the same journal under different keys. Each tab tells the others of every entry it stores (`BroadcastChannel`), and they apply it at once, so both show the same document, as two users editing together would. A tab opens the channel before it reads the document, so an entry another tab stores while it reads arrives either in what it reads or through the channel. Without the channel, each tab merges the other's work at its next checkpoint (section 4.5, steps 2 and 3), and before every save to a file. Yjs merges the two histories; the work tracker and undo treat the other tab's changes as remote, so each tab undoes only its own.

## 6. The user's files

The store is the working copy. The file the user chose is written only when the user saves (`session.saveToFile(target)`), through a `FileTarget`:

- **File System Access API** (`fileHandleTarget`): `createWritable()`, write, `close()`; on any error `abort()`. The browser writes to a temporary copy and puts it in place on `close()`: in the tests, in Chromium and Firefox, a read during the write gave the old content, and an aborted write left the file as it was. Permission is asked for when needed.
- **Download** (`downloadTarget`), where the API is missing: every save is a new file in the downloads folder, so nothing is overwritten. It cannot read back, and the user may cancel the browser's dialog, so nothing confirms that a file exists: a download gives the notice `save-downloaded`, sets `status.downloadedAt` (also kept in the document's description, `downloadedAt`), and leaves the document counting as not saved to a file (so a crash still offers it).
- **Upload** (`uploadedFile`) for opening, where the API is missing.
- **Desktop** (later): a temporary file next to the file, flushed, then renamed over it.
- **Memory** (`memoryFile`), for tests, which can tear a write at any byte, as a file system without atomic replacement would.

`pickFileToOpen` and `pickFileToSave` choose the File System Access API where it exists and the fallbacks otherwise; the caller passes the translated name of the file type.

Before writing, the layer brings in what other tabs have stored (section 5), so the file holds it. After writing, it reads the file back and compares it with what it wrote (`save-verify-failed` if they differ). A save that fails leaves the old file unchanged (or, with a non-atomic file system, possibly cut); either way, the work is in the store.

Saving to a file is the way out when the store fails, so it does not depend on the store: it waits at most `storeWait` (5 seconds) for each thing it asks of the store (taking the latest changes, bringing in other tabs' work, reading assets, noting the save), and if the store fails or does not answer, the file is built from the document in memory and the asset bytes the session holds (section 4.4).

**Closing.** `close()` says whether everything reached the store (`CloseResult`). If not (the store is full, gone, or did not answer within `closeWait`), the session stays open and goes on trying, so the program can offer to save as a file; `close({ evenIfUnstored: true })` then ends it anyway, and the session record stays, so the next start offers what reached the store.

**Opening a file that cannot be read.** `openFile(source)` reads the file and opens it as a new slot. If it cannot be read, the result says why (section 7) and lists, newest first, the slots the store keeps of a file with the same name (`lastGood`): the copy that was opened from it, or last saved to it, with every change since. Opening one of them is `open(slot)`. `exportFile(slot)` writes a stored copy, with its assets, as a Galatsa file, so the user can save it somewhere else.

## 7. What the user is told

Every outcome the user should hear about is a `Notice`: a code, a severity (`info`, `warning`, `error`), values (`name`, `count`, `when`) and, for logs, the error behind it. `noticeText(i18n, notice)` gives the text in the current language; the messages are in `packages/storage/src/messages` (namespace `storage`), in both languages, and `pnpm check` compares them. The same files have the texts for the recovery offer, the last good copy and the save status.

| Code                                                                                                                    | When                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `file-unreadable`                                                                                                       | The file could not be read at all (moved, no permission).                    |
| `file-not-galatsa`, `file-damaged`, `file-newer-version`, `file-too-large`, `file-unsupported`                          | The reader's error codes (0001, section 9.6).                                |
| `stored-damaged`, `stored-missing`, `storage-unavailable`                                                               | A stored document cannot be opened, or the store cannot be used.             |
| `restored-previous-copy`, `changes-lost`, `changes-incomplete`                                                          | Opening found damage and took the last good copy (section 4.5).              |
| `merge-identity-lost`, `file-upgraded`, `document-recovered`, `content-quarantined`, `assets-damaged`, `assets-missing` | The reader's warnings, one notice per kind.                                  |
| `autosave-failed`, `storage-full`, `autosave-newer-version`                                                             | Changes are not reaching the store; shown while it lasts (`status.problem`). |
| `save-failed`, `save-verify-failed`, `save-too-large`, `save-newer-version`, `save-no-merge-state`                      | Saving to the user's file.                                                   |
| `save-downloaded`, `save-download-failed`                                                                               | Saving by download: handed to the browser and not checkable, or not started. |

A failed write to the store keeps the changes in memory and tries again after 2 seconds, then 4, up to once a minute; the session's status says so until a write succeeds. A store that is full or gone never keeps a document from opening: `open`, `create` and `importFile` give a session with `status.problem` set (and the notice in the result), `exportFile` works as long as the store can be read, and the session writes everything (a whole checkpoint first, if the slot has none) once the store takes it.

### 7.1 What the editor must show

- **At start, for each recovery offer:** the title (or "Untitled presentation"), when it last changed (`recovery.offer`), and these choices:
  - _Restore_ (`recovery.restore`): `open(slot)`.
  - _Not now_ (`recovery.later`): nothing; it is offered again at the next start.
  - _Keep it, but don't ask again_ (`recovery.dismiss`, with `recovery.dismiss.detail`): `dismiss(slot)`.
  - For a document saved to a file (`savedToFileAt` set): _Discard the changes_ (`recovery.discardChanges`), after showing `recovery.discardChanges.detail` with `name` = `fileName` and `when` = `savedToFileAt`, so the user sees which save the document goes back to. The program gets the file (the handle it kept, or by asking the user to pick it) and calls `discardChanges(slot, file)`, which opens the file and only then removes the stored copy. If the result is `file-failed`, show its problem and keep the offer.
  - For a document never saved to a file: no "discard"; only _Delete the presentation_ (`recovery.delete`), after showing `recovery.delete.detail` and asking again, then `deleteDocument(slot)`. In that text, and in `recovery.offer`, the program puts "Untitled presentation" (`recovery.untitled`) for `title` when the document has no title.
- **While editing:** the save status from `status` (`status.saving`, `status.saved`, `status.unsavedToFile`, `status.failed`); `status.problem` as a notice that stays until it clears; before the window closes, a warning while `status.pending` or `status.problem` is set.
- **When a document is closed** (not only when the window is): if `status.pending` or `status.problem` is set, or `close()` answers `ok: false`, offer to save as a file before the document goes; close with `evenIfUnstored` only after that offer.
- **After saving:** the result's notices; for a download, `save-downloaded`, which tells the user to check the downloads folder.
- **When a file cannot be opened:** the problem's text and, if `lastGood` is not empty, `lastGood.offer` with _Open the copy_.
- **Once the user has work worth keeping:** call `requestPersistentStorage()`.

## 8. Work tracking and the live resolver

Every document the layer hands out has the work tracker attached (`trackWork`) before it is handed out, so the first change is recorded as work (0001, section 12, assumption 7). The file reader and `fromSnapshot` attach it already; the layer attaches it again where it builds documents itself (it does nothing when attached). The changes the layer applies (stored entries and checkpoints) are remote transactions, which are neither work nor undoable.

The live resolver and the undo manager belong to whoever edits the document: the editor calls `liveResolver(doc)` and `createUndoManager(doc)` on `session.doc`. The live resolver follows every change, including the ones the layer applies.

## 9. The interface for the editor

```ts
const storage = new DocumentStorage({
  backend: await indexedDbBackend(),
  encodeCheckpoint: workerEncoder(new CheckpointWorker()),
});

// At start: unsaved work from a crash (section 7.1).
for (const offer of await storage.recoverable()) {
  // storage.open(offer.slot), storage.dismiss(offer.slot),
  // storage.discardChanges(offer.slot) (only with a file), or storage.deleteDocument(offer.slot)
}

const session = await storage.create({ title }); // a new document
const result = await storage.openFile(source); // a file the user chose
const result = await storage.open(slot); // a stored document
// result: { ok: true, session, notices } | { ok: false, problem, lastGood }

session.doc; // the Y.Doc, ready to edit
session.status;
session.subscribe(listener); // saving, pending, lastStoredAt, unsavedToFile, downloadedAt, problem
await session.putAsset(bytes);
await session.getAsset(id);
await session.saveToFile(target); // { ok: true, notices } | { ok: false, problem }
await session.close(); // { ok: true } or { ok: false, closed: false, problem }: offer to save as a file
await storage.discardChanges(slot, file); // opens the file first, then removes the stored copy
```

`list()` gives every stored document (for a list of recent documents), with whether a running session has it open.

## 10. Tests

| What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Where                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend contract (memory)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Node: `packages/storage/src/parts.test.ts`                                                                                                      |
| Frames: every cut position, flipped bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Node: the same                                                                                                                                  |
| Store, close, reopen; journal and checkpoint timing; work tracking attached; assets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Node: `storage.test.ts`                                                                                                                         |
| Crash: work offered and restored; running sessions not offered; heartbeats; journal write torn; checkpoint torn at 13 positions; newest checkpoint cut at about 60 positions and with a flipped byte; checkpoints without usable Yjs state; every copy damaged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Node: `storage.test.ts`                                                                                                                         |
| User's file torn at about 80 positions in a save: clear notice and the last good copy, which holds the latest work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Node: `storage.test.ts`                                                                                                                         |
| Two tabs, with and without a channel; three sessions racing checkpoints under random interleavings (12 seeds)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Node: `storage.test.ts`                                                                                                                         |
| Faults: a worker that never answers, sends unreadable messages or hangs; damaged journal entries in the middle (later checkpoints keep merge identity; reported once; removed), also another tab's met by a running tab; changes made while the store is busy; a tab that opens while another stores; saving after another tab stored, without a channel; a damaged newest checkpoint met by a running tab; failed lock queries; downloads; a file that reads back differently; saving with the store gone; a full store when opening, creating and importing; checkpoints flushing the journal first (also from the timer); a checkpoint that reads back differently; discarding a document without a file; merge identity over random scenarios; the last good copy after three racing sessions, with and without programs stopped in the middle of writes (10 seeds each) | Node: `faults.test.ts`                                                                                                                          |
| Flows: `close()` with a full store (stays open, saving as a file works, closing anyway) and with a store that does not answer; saving to a file with a store that does not answer; the recovery offer's last save and download times; a document only downloaded cannot be discarded; discarding opens the file first and keeps everything when the file fails; `dismiss` keeps unsaved state; failed lock queries; an unreadable session record counts as running; a document deleted while opened is written again; every recovery text filled in                                                                                                                                                                                                                                                                                                                          | Node: `flows.test.ts`                                                                                                                           |
| Random scenarios of 0001 section 15 (15 seeds) stored through the layer, with crashes and reopenings: every reopening gives the document the session held                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Node: `property.test.ts`                                                                                                                        |
| Notices: a message in both languages for every code, no missing value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Node: `parts.test.ts`                                                                                                                           |
| IndexedDB contract; a new connection after the browser closed the old one; a stopped page's work offered and restored; damaged newest checkpoint; two tabs; file handles (origin private file system) with a write given up halfway; the checkpoint worker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Chromium and Firefox, headless, through Playwright: `tests/e2e/storage.spec.ts` against `bench/storage-check.html` (`pnpm e2e storage.spec.ts`) |
| IndexedDB contract; damaged newest checkpoint; the checkpoint worker; work offered and restored after the web process is killed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | WebKitGTK 2.54.3: `tests/e2e/webkitgtk/storage_check.py` under Xvfb                                                                             |

The file format's own property test ("files written during random scenarios read back as the same document") is unchanged and still passes.

Mutations checked to make the tests fail (each applied alone, the tests run, the change thrown away): letting `create` overwrite an existing key; removing the base checkpoint after a new one; dropping changes made while a journal entry is written; not checking a saved file; not reading a checkpoint back; taking an unreadable newest checkpoint as the base; not flushing the journal before a checkpoint; taking damaged entries as held (when opening and when merging); not dropping pending updates (when opening and when merging); no time limit on the encoder; opening the channel after reading; not merging before saving to a file; heartbeats only without locks; counting a download as saved; one first checkpoint instead of two; throwing a store error when a session starts; not resetting the generation when a session finds no checkpoint; taking an unreadable session record as stopped; discarding without a save to a file; a failed lock query taken as "none running"; a download setting `savedToFileAt`; `close()` closing although changes are not stored; saving to a file without a time limit on the store; discarding before the file has opened; `dismiss` forgetting unsaved changes.

Playwright's WebKit could not run on the development machine (it needs libraries of a particular Ubuntu release), so WebKit was tested in the system's WebKitGTK instead, which is also the engine of the Linux desktop app. That session had no origin private file system, so file handles were not tested there, nor were two tabs.

## 11. Known limitations and open questions

1. **The last second.** Changes made in the last 0.3 to 1 second before a crash are lost. Storing on every change would remove that window at the cost of a write per keystroke.
2. **Two damaged copies.** If both the newest checkpoint and the one before it are damaged, the document cannot be opened. Keeping three generations would cost one more checkpoint of space.
3. **Browser eviction.** Without persistent storage, a browser may delete the site's data under storage pressure. `requestPersistentStorage()` exists; the editor has to call it and tell the user to save important work as files.
4. **Old slots** are kept until discarded. A policy for removing slots that are closed, saved to their file and old (keeping enough for the last good copy of recent files) is needed before the web app is released.
5. **Approximations in descriptions.** `changedAt` is updated at checkpoints and, in session records, at most every 10 seconds; whether a stored document has changes not saved to its file is exact while a session runs, and an estimate for a document closed cleanly (from `changedAt` and `savedToFileAt`).
6. **Opening a large document** reads a checkpoint through the full file reader: 0.9 seconds for 5000 elements. Opening the Yjs state alone would be faster, but would skip the reader's check that `document.json` and `ydoc.bin` agree.
7. **The worker needs the bundler.** The worker module is an entry of the package; how it is started (`?worker` in Vite, or `new Worker(new URL(...))`) is up to the program.
8. **The desktop backend** (phase 2) must meet section 3's guarantees; `checkBackendContract` is ready for it. Concurrent windows of the desktop app are the same as tabs, if the desktop gives them a lock or a heartbeat.
9. **Work on this thread.** When another tab wrote the newest checkpoint, merging it reads it on the editing thread (about 930 ms for 5000 boxes, measured in Node); and `saveToFile` builds the whole file, with its assets, on the editing thread. Both could move to the worker.
10. **Assets in memory.** A session keeps the bytes of the assets it has seen, so that saving to a file works without the store. For documents with much media this costs memory; a limit, with the store as the only copy beyond it, may be needed.
11. **Dropped changes.** Changes that build on a damaged journal entry are dropped from the session's document; they stay in their journal entries only until the next checkpoint. If no running session holds what they build on, they are lost, and the user is told (`changes-incomplete`). `dropPending` works on the whole document and must be narrowed before sync is added (section 4.5).
12. **Merging two copies with different lineages** (the user opens the same file twice, as two slots) is not done by the layer; each is its own document. `importCopy` (0001, section 9.3) is the way to bring one into the other.

## 12. Rejected alternatives

- **Saving the whole file on a timer only.** Simple, but the cost of a save (section 4.2) forces a long interval, and a crash loses up to that interval. Kept as the checkpoint, behind the journal.
- **A journal only, no checkpoints.** Opening would replay the whole history, and the journal would grow without bound.
- **Raw Yjs state as checkpoints.** Much cheaper to write and read, but with only one representation of the document, no independent `document.json` to fall back on and no reuse of the file reader's checks. The worker removes the cost from the editing thread instead.
- **A "current checkpoint" pointer record, swapped with compare-and-swap.** Needs compare-and-swap of a value in every backend; a free generation number with "create if absent" gives the same with an operation every backend has (IndexedDB `add`, a hard link on a file system).
- **One writer at a time, through a lock.** Would avoid concurrent checkpoints, but a tab that holds the lock and freezes would stop the others from storing anything; and locks are not available everywhere. With per-session journal keys and a free generation number, no session ever waits for another.
- **The `y-indexeddb` library** stores Yjs updates in IndexedDB (from memory, not checked). It covers only the journal part for one backend, without checkpoints in the file format, damage detection, assets, recovery offers or the desktop.
