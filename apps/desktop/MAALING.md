# Slik kjører du målingen

Galatsa er et presentasjonsprogram som er under arbeid. Før vi bygger videre, må vi velge hvilken _tegnemotor_ programmet skal bruke, altså den delen som tegner alt du ser på skjermen. Vi har tre kandidater, og vi vil vite hvordan de oppfører seg på vanlige maskiner. Derfor ber vi deg kjøre et lite måleprogram på maskinen din og sende oss resultatet.

Programmet viser den samme prøvescenen med hver av de tre motorene, flytter og zoomer rundt i den, og lagrer tallene i en mappe. Det sender ingenting over nettet og endrer ingenting på maskinen utover å lagre resultatene.

Det tar omtrent en halvtime i alt, medregnet nedlasting. Selve målingen tar 15 til 25 minutter, og da skal du ikke bruke maskinen.

## 1. Last ned programmet

Programmet bygges automatisk på GitHub, en nettjeneste der koden til Galatsa ligger. Den som ba deg om å kjøre målingen, sender deg en lenke.

1. Logg inn på GitHub (github.com). Filene kan bare lastes ned av innloggede brukere. En gratis konto holder.
2. Åpne lenken. Du kommer til en side for en «workflow run» (en automatisk bygging). Rull ned til **Artifacts** (de ferdige filene).
3. Last ned den som passer maskinen din:
   - **galatsa-maaling-windows** for Windows
   - **galatsa-maaling-macos** for Mac
   - **galatsa-maaling-linux** for Linux
4. Du får en zip-fil. Pakk den ut (dobbeltklikk på den, eller høyreklikk og velg «Pakk ut alle» på Windows).

Filene blir slettet fra GitHub etter 30 dager. Er de borte, be om en ny bygging.

Programmet er ikke _signert_. Signering er et slags stempel fra Microsoft eller Apple som viser hvem som har laget programmet, og det koster penger. Uten stempelet advarer maskinen før første oppstart. Slik kommer du forbi advarselen:

### Windows

1. Dobbeltklikk på filen som slutter på `-setup.exe`.
2. Windows viser «Windows beskyttet PC-en». Dette er _SmartScreen_, Windows sin vakt mot ukjente programmer. Klikk **Mer informasjon**, og deretter **Kjør likevel**.
3. Følg installasjonen. Start programmet **Galatsa-maaling** fra Start-menyen.

### Mac

1. Dobbeltklikk på `.dmg`-filen, og dra **Galatsa-maaling** over til **Programmer**.
2. Åpne **Programmer**, høyreklikk (eller hold Ctrl og klikk) på **Galatsa-maaling** og velg **Åpne**. Klikk **Åpne** i spørsmålet som kommer.
3. På nyere macOS (15 Sequoia og senere) får du ikke det valget. Prøv å åpne programmet én gang, og klikk **Ferdig** når macOS nekter. Gå så til **Systeminnstillinger → Personvern og sikkerhet**, rull ned, og klikk **Åpne likevel** ved Galatsa-maaling. Bekreft med passordet ditt.
4. Sier macOS at programmet er «skadet»? Det skyldes at det er lastet ned fra nettet uten stempel. Åpne programmet **Terminal** og skriv `xattr -cr /Applications/Galatsa-maaling.app` og trykk Enter. Prøv deretter på nytt.

### Linux

- På Debian og Ubuntu: installer `.deb`-filen, for eksempel med `sudo apt install ./Galatsa-maaling_*.deb`, og start **Galatsa-maaling** fra menyen.
- På andre utgaver: bruk programfilen `galatsa-bench-shell`. Gjør den kjørbar (`chmod +x galatsa-bench-shell`) og start den. Den trenger WebKitGTK 4.1 fra systemet (pakken `webkit2gtk-4.1` på Arch). Du kan også bygge programmet selv; se `apps/desktop/README.md`.
- Ikke bruk `.AppImage`-filen til målingen. Den har med sin egen, eldre utgave av nettlesermotoren, så tallene ville ikke vise hvordan maskinen din oppfører seg.

## 2. Gjør maskinen klar

Målingen sammenligner tre motorer på samme maskin, og tallene blir mest til å stole på når maskinen er i ro.

- **Sett i strømledningen.** På batteri senker mange maskiner farten for å spare strøm.
- **Slå av strømsparing.** På Mac: **Systeminnstillinger → Batteri**, sett **Strømsparingsmodus** til **Aldri**. På Windows: **Innstillinger → System → Strøm og batteri**, velg en annen modus enn «Beste strømeffektivitet», og slå av batterisparing.
- **Lukk andre programmer**, særlig nettlesere, videomøter og spill.
- **Sett skjermen til 60 Hz eller 120 Hz** hvis du kan velge. Hz (hertz) er hvor mange ganger i sekundet skjermen viser et nytt bilde. Målingen sjekker om hvert bilde blir ferdig på 16,7 eller 33 tusendels sekunder. Ved 60 og 120 Hz går de tidene opp i skjermens takt, så målingen ser både hvor lang tid programmet bruker og når bildet faktisk kommer på skjermen. Ved 75, 100 eller 144 Hz går de ikke opp, og da kan målingen bare telle programmets eget arbeid. Forsinkelser andre steder blir ikke med, så tallene blir mindre fullstendige. Du finner innstillingen her:
  - Windows: **Innstillinger → System → Skjerm → Avansert skjerm → Velg en oppdateringsfrekvens**.
  - Mac: **Systeminnstillinger → Skjermer → Oppdateringsfrekvens** (bare på noen Mac-er; «ProMotion» går også fint).
  - Linux: i skjerminnstillingene på skrivebordet ditt.
- **Bruk vanlig skalering** (for eksempel 100 % eller den anbefalte på Windows). Skalering er hvor store tekst og knapper vises. Målevinduet trenger plass til et bilde på 960 × 540 punkter. Sier programmet at vinduet er for lite, setter du skaleringen lavere.
- **Sørg for at skjermen ikke slukker** eller låser seg i løpet av en halvtime.

Har du flere skjermer, la programmet ligge på den skjermen du bruker mest.

## 3. Kjør målingen

1. Start **Galatsa-maaling**. Du kan bytte mellom norsk og engelsk øverst.
2. Klikk **Kjør alle målinger**.
3. La maskinen være i fred til målingen er ferdig. Ikke flytt eller endre størrelse på vinduet, og ikke legg andre vinduer over det. Du vil se prøvescenen bevege seg øverst i vinduet. Det er helt normalt at det hakker eller står stille en stund.

Programmet kjører hver motor tre ganger: én oppvarming der det tar bilder av scenen, og to tidsmålinger. Mellom hver motor laster det siden på nytt og lager prøvebildene på nytt, så det ser ut som det står stille en stund. Ved hver start venter det også til maskinen er i ro.

Knappene for én og én motor trenger du bare hvis den som ba deg om målingen, sier det.

## 4. Send resultatet

Når målingen er ferdig, står det **Ferdig** med en kort oppsummering, og hvor resultatene ligger. De ligger i mappen **Dokumenter/Galatsa-maaling**, i en undermappe med dato, klokkeslett og navnet på operativsystemet, for eksempel `2026-11-30_19-05-12_windows`.

1. Klikk **Åpne mappen med resultater**.
2. Pakk undermappen som en zip-fil:
   - Windows: høyreklikk på mappen og velg **Send til → Komprimert (zippet) mappe**.
   - Mac: høyreklikk på mappen og velg **Komprimer**.
   - Linux: høyreklikk og velg **Komprimer** (eller tilsvarende).
3. Send zip-filen til den som ba deg om å kjøre målingen, på den måten dere har avtalt.

Filene inneholder tall fra målingen og en beskrivelse av maskinen: operativsystem, prosessor, skjermkort, minne, skjermstørrelse og om maskinen gikk på strøm eller batteri. De inneholder ikke navnet ditt eller andre personlige opplysninger.

Gikk noe galt, eller sto programmet stille i mer enn 10 minutter? Ta et skjermbilde, lukk programmet, og send skjermbildet sammen med mappen.

## Hvorfor ikke bare måle på GitHub?

GitHub bygger programmet på egne maskiner og sjekker at det virker. Men det er virtuelle maskiner uten vanlig skjermkort, så tallene derfra sier lite om hvordan programmet vil oppføre seg hos folk. Derfor trenger vi målinger fra ekte maskiner.
