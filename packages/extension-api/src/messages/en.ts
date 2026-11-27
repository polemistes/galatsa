// SPDX-License-Identifier: GPL-3.0-or-later

export default {
  "placeholder.missing": "Missing extension: {type}",
  "placeholder.newer": "Needs a newer version of the extension: {type}",
  "placeholder.failed": "Could not be drawn: {type}",
  "problem.invalid": "The extension {extension} is not valid and was not started.",
  "problem.duplicate": "The extension {extension} is loaded already.",
  "problem.api-version":
    "The extension {extension} was made for another version of Galatsa and was not started.",
  "problem.missing-dependency":
    "The extension {extension} needs {dependency}, which is missing.",
  "problem.dependency-failed":
    "The extension {extension} was not started because {dependency} could not be started.",
  "problem.cycle":
    "The extension {extension} was not started because extensions depend on each other in a circle.",
  "problem.activate-failed": "The extension {extension} could not be started.",
  "problem.shortcut-conflict":
    "The shortcut {shortcut} is used by two commands; {ignored} does not get it.",
};
