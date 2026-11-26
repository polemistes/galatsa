// SPDX-License-Identifier: GPL-3.0-or-later

// Messages of the measurement app in English (namespace "desktop"). Keys must
// match nb.ts.

export default {
  "app.title": "Galatsa – rendering engine measurement",
  "app.intro":
    "This program measures how well three different rendering engines perform on this machine. It shows the same test scene with each engine and saves the numbers in a folder.",
  "app.before":
    "Before you start: plug in the power cable, close other programs, and leave the window alone while the measurement runs. Do not move or resize the window.",
  "app.language": "Language",
  "engine.konva": "Konva",
  "engine.canvas2d": "Custom canvas drawing",
  "engine.dom": "Browser elements (DOM)",
  "action.runAll": "Run all measurements",
  "action.runAllHint":
    "Takes about {minutes} minutes. Each engine runs three times: one warm-up with images and two timing runs.",
  "action.runOne": "Run {engine} only",
  "action.openFolder": "Open the results folder",
  "action.back": "Back to start",
  "window.tooSmall":
    "The window is too small. The measurement needs at least {needWidth} × {needHeight} points, but the window has {width} × {height}. Make the window larger or lower the display scaling.",
  "window.ok": "The window is large enough ({width} × {height} points).",
  "results.where": "Results are saved in: {path}",
  "results.savedIn": "The results were saved in: {path}",
  "results.title": "Done",
  "results.sendHint":
    "Compress the folder into a zip file and send it to the person who asked you to run the measurement.",
  "results.none": "No results were found for this measurement.",
  "run.progress": "Measurement {step} of {total}: {engine}, {kind}.",
  "run.kind.capture": "warm-up with images",
  "run.kind.timing": "timing run",
  "run.leaveAlone": "Leave the window alone until the measurement is finished.",
  "run.saving": "Saving the results …",
  "run.failed": "The measurement with {engine} stopped: {message}",
  "run.badPlan": "This page was opened without a measurement plan.",
  "summary.header": "Galatsa measurement {session}",
  "summary.machine": "Machine: {os}, {cpu}, web engine {webview} {version}",
  "summary.engine": "{engine}",
  "summary.run":
    "  Run {run} ({kind}): display {hz} Hz, 16.7 ms: {f16}, 33 ms: {f33}, no stall over 100 ms: {stalls}, sharp text: {text}, memory {memory}: {memoryVerdict}",
  "summary.notValid": "  Run {run} cannot be used for the decision: {problems}",
  "summary.agree":
    "  The two timing runs {agree, select, yes {give the same verdict} no {give different verdicts} other {cannot be compared}}.",
  "summary.error": "  Error: {message}",
  "summary.memoryProblem": "  Memory could not be measured fully: {problem}",
  "verdict.pass": "pass",
  "verdict.fail": "fail",
  "verdict.unknown": "cannot judge",
  "memory.unknown": "unknown",
};
