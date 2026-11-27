// SPDX-License-Identifier: GPL-3.0-or-later

// Messages of the storage layer in Norwegian Bokmål (namespace "storage"). Keys
// must match en.ts; `pnpm check` compares them.

export default {
  "notice.file-unreadable":
    "«{name}» kunne ikke leses. Kanskje fila er flyttet, eller Galatsa ikke har lov til å åpne den.",
  "notice.file-not-galatsa": "«{name}» er ikke en Galatsa-presentasjon.",
  "notice.file-damaged":
    "«{name}» er skadet og kan ikke åpnes. Det kan skje hvis lagringen ble avbrutt, eller hvis fila ikke ble kopiert helt.",
  "notice.file-newer-version":
    "«{name}» er laget med en nyere versjon av Galatsa. Oppdater Galatsa for å åpne den.",
  "notice.file-too-large": "«{name}» er for stor til at Galatsa kan åpne den.",
  "notice.file-unsupported":
    "«{name}» bruker noe Galatsa ikke støtter, for eksempel kryptering.",
  "notice.stored-damaged":
    "Kopien Galatsa tok vare på av denne presentasjonen, er skadet og kan ikke åpnes.",
  "notice.stored-missing": "Galatsa har ikke lenger noen kopi av denne presentasjonen.",
  "notice.storage-unavailable":
    "Galatsa får ikke brukt lageret i nettleseren. Arbeidet ditt blir ikke lagret automatisk.",
  "notice.restored-previous-copy":
    "Den siste kopien Galatsa tok vare på, var skadet. Arbeidet ditt er hentet fra kopien før den, med endringene som er gjort siden.",
  "notice.changes-lost":
    "{count, plural, one {Én lagret endring var skadet og kunne ikke hentes tilbake.} other {# lagrede endringer var skadet og kunne ikke hentes tilbake.}}",
  "notice.changes-incomplete":
    "Noen endringer kunne ikke vises, fordi endringer de bygger på, mangler.",
  "notice.merge-identity-lost":
    "Denne presentasjonen kan ikke lenger flettes med andre kopier av den. Du kan fortsatt hente innhold fra en annen kopi.",
  "notice.file-upgraded":
    "Fila var laget med en eldre versjon av Galatsa og er oppdatert.",
  "notice.document-recovered":
    "En del av fila var skadet. Presentasjonen er hentet tilbake fra redigeringshistorikken.",
  "notice.content-quarantined":
    "Presentasjonen har innhold som denne versjonen av Galatsa ikke viser. Det blir tatt vare på som det er.",
  "notice.assets-damaged":
    "{count, plural, one {Ett bilde eller én mediefil er skadet og vises som manglende.} other {# bilder eller mediefiler er skadet og vises som manglende.}}",
  "notice.assets-missing":
    "{count, plural, one {Ett bilde eller én mediefil mangler.} other {# bilder eller mediefiler mangler.}}",
  "notice.autosave-failed":
    "De siste endringene dine kunne ikke lagres. Galatsa prøver igjen. Ikke lukk vinduet før denne meldingen er borte.",
  "notice.storage-full":
    "Lageret er fullt, så Galatsa kan ikke lagre endringene dine automatisk. Du kan arbeide videre og lagre presentasjonen som fil. Frigjør plass for å slå på automatisk lagring igjen.",
  "notice.autosave-newer-version":
    "Noen redigerer denne presentasjonen med en nyere versjon av Galatsa. Denne versjonen kan ikke lenger lagre den.",
  "notice.save-failed": "«{name}» kunne ikke lagres. Fila du hadde, er uendret.",
  "notice.save-verify-failed":
    "«{name}» ble lagret, men da den ble lest tilbake, var innholdet et annet. Lagre igjen, eller velg et annet sted.",
  "notice.save-downloaded":
    "«{name}» er gitt til nettleseren som en nedlasting. Galatsa kan ikke kontrollere at den kom fram, så presentasjonen regnes fortsatt som ikke lagret i fil. Se etter i mappen for nedlastinger.",
  "notice.save-download-failed":
    "Nedlastingen av «{name}» kunne ikke startes. Arbeidet ditt er fortsatt tatt vare på i Galatsa.",
  "notice.save-too-large":
    "Presentasjonen er for stor til å lagres som én fil. Legg store mediefiler i egne filer ved siden av presentasjonen.",
  "notice.save-newer-version":
    "Denne presentasjonen trenger en nyere versjon av Galatsa, så denne versjonen kan ikke lagre den.",
  "notice.save-no-merge-state":
    "Fila ble lagret, men uten historikken som gjør at den kan flettes med andre kopier.",
  "recovery.heading": "Ulagret arbeid",
  "recovery.offer":
    "«{title}» ble ikke lukket som vanlig. Siste endring ble gjort {when, date, medium} klokka {when, time, short}. Vil du fortsette der du slapp?",
  "recovery.untitled": "Presentasjon uten navn",
  "recovery.restore": "Hent tilbake",
  "recovery.later": "Ikke nå",
  "recovery.dismiss": "Behold, men ikke spør igjen",
  "recovery.dismiss.detail":
    "«{title}» blir liggende i Galatsas liste over presentasjoner med arbeidet som er hentet tilbake, og du blir ikke spurt om den igjen.",
  "recovery.discardChanges": "Forkast endringene",
  "recovery.discardChanges.detail":
    "Endringene som er gjort etter at «{name}» sist ble lagret, {when, date, medium} klokka {when, time, short}, går tapt. Galatsa åpner fila slik den var da. Nedlastinger etter det regnes ikke som lagring.",
  "recovery.delete": "Slett presentasjonen",
  "recovery.delete.detail":
    "«{title}» er aldri lagret som fil. Å slette den fjerner hele presentasjonen fra Galatsa, ikke bare de siste endringene. Dette kan ikke angres.",
  "lastGood.offer":
    "Galatsa tok vare på en kopi av «{name}» fra {when, date, medium} klokka {when, time, short}. Vil du åpne kopien?",
  "lastGood.open": "Åpne kopien",
  "status.saving": "Lagrer …",
  "status.saved": "Lagret {when, time, short}",
  "status.unsavedToFile": "Endringer som ikke er lagret i fila",
  "status.failed": "Ikke lagret",
};
