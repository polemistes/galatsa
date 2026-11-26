// SPDX-License-Identifier: GPL-3.0-or-later

// Messages of the measurement app in Norwegian Bokmål (namespace "desktop"). Keys
// must match en.ts.

export default {
  "app.title": "Galatsa – måling av tegnemotorer",
  "app.intro":
    "Dette programmet måler hvor godt tre ulike tegnemotorer klarer seg på denne maskinen. Det viser den samme prøvescenen med hver motor og lagrer tallene i en mappe.",
  "app.before":
    "Før du starter: sett i strømledningen, lukk andre programmer, og la vinduet være i fred mens målingen går. Ikke flytt eller endre størrelse på vinduet.",
  "app.language": "Språk",
  "engine.konva": "Konva",
  "engine.canvas2d": "Egen canvas-tegning",
  "engine.dom": "Nettleserens egne elementer (DOM)",
  "action.runAll": "Kjør alle målinger",
  "action.runAllHint":
    "Tar omtrent {minutes} minutter. Hver motor kjøres tre ganger: én oppvarming med bilder og to tidsmålinger.",
  "action.runOne": "Kjør bare {engine}",
  "action.openFolder": "Åpne mappen med resultater",
  "action.back": "Tilbake til start",
  "window.tooSmall":
    "Vinduet er for lite. Målingen trenger minst {needWidth} × {needHeight} punkter, men vinduet har {width} × {height}. Gjør vinduet større eller sett skjermskaleringen lavere.",
  "window.ok": "Vinduet er stort nok ({width} × {height} punkter).",
  "results.where": "Resultatene lagres i: {path}",
  "results.savedIn": "Resultatene ble lagret i: {path}",
  "results.title": "Ferdig",
  "results.sendHint":
    "Pakk mappen som en zip-fil og send den til den som ba deg om å kjøre målingen.",
  "results.none": "Fant ingen resultater for denne målingen.",
  "run.progress": "Måling {step} av {total}: {engine}, {kind}.",
  "run.kind.capture": "oppvarming med bilder",
  "run.kind.timing": "tidsmåling",
  "run.leaveAlone": "La vinduet være i fred til målingen er ferdig.",
  "run.saving": "Lagrer resultatene …",
  "run.failed": "Målingen med {engine} stoppet: {message}",
  "run.badPlan": "Denne siden ble åpnet uten en plan for målingen.",
  "summary.header": "Galatsa-måling {session}",
  "summary.machine": "Maskin: {os}, {cpu}, nettlesermotor {webview} {version}",
  "summary.engine": "{engine}",
  "summary.run":
    "  Kjøring {run} ({kind}): skjerm {hz} Hz, 16,7 ms: {f16}, 33 ms: {f33}, ingen stopp over 100 ms: {stalls}, skarp tekst: {text}, minne {memory}: {memoryVerdict}",
  "summary.notValid": "  Kjøring {run} kan ikke brukes til valget: {problems}",
  "summary.agree":
    "  De to tidsmålingene {agree, select, yes {gir samme dom} no {gir ulik dom} other {kan ikke sammenlignes}}.",
  "summary.error": "  Feil: {message}",
  "summary.memoryProblem": "  Minnet kunne ikke måles helt: {problem}",
  "verdict.pass": "bestått",
  "verdict.fail": "ikke bestått",
  "verdict.unknown": "kan ikke vurderes",
  "memory.unknown": "ukjent",
};
