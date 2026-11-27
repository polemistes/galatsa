// SPDX-License-Identifier: GPL-3.0-or-later

// Messages of the storage layer in English (namespace "storage"). Keys must match
// nb.ts; `pnpm check` compares them.

export default {
  "notice.file-unreadable":
    "“{name}” could not be read. The file may have been moved, or Galatsa may not have permission to open it.",
  "notice.file-not-galatsa": "“{name}” is not a Galatsa presentation.",
  "notice.file-damaged":
    "“{name}” is damaged and cannot be opened. This can happen if saving was interrupted, or if the file was not copied completely.",
  "notice.file-newer-version":
    "“{name}” was made with a newer version of Galatsa. Update Galatsa to open it.",
  "notice.file-too-large": "“{name}” is too large for Galatsa to open.",
  "notice.file-unsupported":
    "“{name}” uses a feature Galatsa does not support, such as encryption.",
  "notice.stored-damaged":
    "The copy Galatsa kept of this presentation is damaged and cannot be opened.",
  "notice.stored-missing": "Galatsa no longer has a copy of this presentation.",
  "notice.storage-unavailable":
    "Galatsa cannot use the browser’s storage. Your work is not being saved automatically.",
  "notice.restored-previous-copy":
    "The latest copy Galatsa kept was damaged. Your work was restored from the copy before it, with the changes made since.",
  "notice.changes-lost":
    "{count, plural, one {One saved change was damaged and could not be restored.} other {# saved changes were damaged and could not be restored.}}",
  "notice.changes-incomplete":
    "Some changes could not be shown, because changes they depend on are missing.",
  "notice.merge-identity-lost":
    "This presentation will no longer merge with other copies of it. You can still bring in content from another copy.",
  "notice.file-upgraded":
    "The file was made with an older version of Galatsa and was updated.",
  "notice.document-recovered":
    "Part of the file was damaged. The presentation was recovered from its editing history.",
  "notice.content-quarantined":
    "The presentation holds content this version of Galatsa does not show. It is kept as it is.",
  "notice.assets-damaged":
    "{count, plural, one {One image or media file is damaged and is shown as missing.} other {# images or media files are damaged and are shown as missing.}}",
  "notice.assets-missing":
    "{count, plural, one {One image or media file is missing.} other {# images or media files are missing.}}",
  "notice.autosave-failed":
    "Your latest changes could not be saved. Galatsa keeps trying. Do not close the window until this message is gone.",
  "notice.storage-full":
    "The storage is full, so Galatsa cannot save your changes automatically. You can go on working, and save the presentation as a file. Free some space to turn autosave back on.",
  "notice.autosave-newer-version":
    "Someone is editing this presentation with a newer version of Galatsa. This version can no longer save it.",
  "notice.save-failed": "“{name}” could not be saved. The file you had is unchanged.",
  "notice.save-verify-failed":
    "“{name}” was saved, but reading it back gave something else. Save again, or choose another place.",
  "notice.save-downloaded":
    "“{name}” was handed to the browser as a download. Galatsa cannot check that it arrived, so the presentation still counts as not saved to a file. Check your downloads folder.",
  "notice.save-download-failed":
    "The download of “{name}” could not be started. Your work is still kept in Galatsa.",
  "notice.save-too-large":
    "The presentation is too large to save as one file. Keep large media in files next to the presentation.",
  "notice.save-newer-version":
    "This presentation needs a newer version of Galatsa, so this version cannot save it.",
  "notice.save-no-merge-state":
    "The file was saved, but without the history that lets it merge with other copies.",
  "notice.save-without-previews":
    "The file was saved without the smaller copies of its images, because it would have been too large with them. It opens more slowly; nothing of the presentation is missing.",
  "recovery.heading": "Unsaved work",
  "recovery.offer":
    "“{title}” was not closed properly. The last change was made {when, date, medium} at {when, time, short}. Do you want to continue where you left off?",
  "recovery.untitled": "Untitled presentation",
  "recovery.restore": "Restore",
  "recovery.later": "Not now",
  "recovery.dismiss": "Keep it, but don’t ask again",
  "recovery.dismiss.detail":
    "“{title}” stays in Galatsa’s list of presentations with the restored work, and you will not be asked about it again.",
  "recovery.discardChanges": "Discard the changes",
  "recovery.discardChanges.detail":
    "The changes made after “{name}” was last saved, {when, date, medium} at {when, time, short}, will be lost. Galatsa opens the file as it was then. Downloads made since do not count as saves.",
  "recovery.delete": "Delete the presentation",
  "recovery.delete.detail":
    "“{title}” has never been saved as a file. Deleting it removes the whole presentation from Galatsa, not only the latest changes. This cannot be undone.",
  "lastGood.offer":
    "Galatsa kept a copy of “{name}” from {when, date, medium} at {when, time, short}. Do you want to open the copy?",
  "lastGood.open": "Open the copy",
  "status.saving": "Saving…",
  "status.saved": "Saved {when, time, short}",
  "status.unsavedToFile": "Changes not saved to the file",
  "status.failed": "Not saved",
};
