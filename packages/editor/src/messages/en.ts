// SPDX-License-Identifier: GPL-3.0-or-later

// Text of the editor in English (namespace "editor"). Keys must match nb.ts;
// `pnpm check` compares them.

export default {
  "canvas.label": "Canvas",
  "file.type": "Galatsa presentation",
  "document.untitled": "Untitled presentation",
  "action.saveAsFile": "Save as file",
  "action.close": "Close the presentation",
  "action.dismissNotice": "Dismiss the message",
  "status.opening": "Opening…",
  "status.closing": "Closing the presentation…",
  "status.closed": "The presentation is closed.",
  "status.savingFile": "Saving as a file…",
  "status.notStored": "Not saved – save as a file",
  "status.noStorage":
    "The browser’s storage cannot be used. Your work is not saved automatically; save the presentation as a file.",
  "close.heading": "Not everything is saved",
  "close.detail":
    "Some changes are not yet stored in the browser. Save the presentation as a file before closing, so nothing is lost.",
  "close.anyway": "Close without saving",
  "close.keepOpen": "Keep it open",
  "unload.warning": "Some changes are not saved yet.",
  "recovery.deleteConfirm": "Yes, delete the presentation",
  "recovery.discardConfirm": "Choose the file and discard the changes",
  "recovery.discardNoFile": "No file was chosen. Nothing was discarded.",
  "recovery.otherDocument":
    "“{name}” is a different presentation. Nothing was discarded. Choose the file the presentation was last saved to.",
  "problems.heading": "Something was not loaded",
  "menu.label": "Actions",
  "menu.cut": "Cut",
  "paste.tooLarge":
    "There is too much on the clipboard to paste at once. Copy fewer elements and try again.",
  "paste.otherVersion":
    "This was copied from another version of Galatsa and cannot be pasted here.",
  "paste.damaged":
    "What is on the clipboard could not be pasted: it is damaged or incomplete.",
  "import.clipboardName": "Pasted image {number}",
  "import.choose": "Insert a file…",
  "import.unsupported":
    "“{name}” cannot be inserted: no part of the program reads files of its kind.",
  "import.failed": "“{name}” could not be inserted.",
  "import.tooLarge":
    "“{name}” was not inserted: files larger than {size} MB cannot be inserted.",
  "import.tooMany": "Only the first {count} files were inserted.",
  "paste.assetsMissing":
    "{count, plural, one {# image} other {# images}} in what was pasted could not be found in this program. They show as missing and are not saved with the presentation; insert them from their files.",
  "panels.label": "Panels",
  "nav.zoomIn": "Zoom in",
  "nav.zoomOut": "Zoom out",
  "nav.actualSize": "Actual size",
  "nav.viewAll": "Show everything",
  "nav.viewSelection": "Show the selection",
  "nav.panLeft": "Move the view left",
  "nav.panRight": "Move the view right",
  "nav.panUp": "Move the view up",
  "nav.panDown": "Move the view down",
  "frames.rename": "Rename frame…",
  "frames.panel": "Frame name",
  "frames.name": "Name of the frame",
  "frames.save": "Save",
  "frames.none": "Select one frame to rename it.",
};
