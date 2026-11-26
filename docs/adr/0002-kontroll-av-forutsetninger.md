# 0002 Kontroll av forutsetninger

- **Status:** Til gjennomgang
- **Dato:** 2026-11-26
- **Kilder åpnet:** Alle lenker i notatet ble åpnet 2026-11-26, om ikke annet står. To sider fra gnu.org er lest i kopier fra Internet Archive, se del 2.

## Kort fortalt

- **Lisenser:** Alle planlagte bibliotek har lisenser som er forenlige med GPL-3.0-or-later: MIT, ISC, Apache-2.0, «Apache-2.0 eller MIT», LGPL/BSD (WebKitGTK) eller offentlig eiendom (SQLite, Natural Earth). Ingen av dem er til hinder. Tauri-logoen har en ufri lisens og skal ikke brukes.
- **Lisenslistene i kontrollen:** Ingen oppføring på produksjonslisten er funnet uforenlig med GPL-3. Én er ubekreftet (BlueOak-1.0.0). Alle på utviklingslisten er bekreftet frie. Forslag til rettelser står i del 7.
- **Tauri på Linux:** Til bygging trengs WebKitGTK 4.1 med utviklingsfiler og noen verktøy. En installert app trenger bare WebKitGTK 4.1 og GTK 3 (og et bibliotek for systemfeltet hvis det brukes). Tauris byggeverktøy oppgir dem som avhengigheter i deb- og rpm-pakkene, og har en tilsvarende liste for Arch. De bygges ikke inn i pakken.
- **Canvas i WebKitGTK:** Tegningen er skrevet om (Skia fra 2.46 i 2024, ny sammensetter i 2.54 i 2026), og nyere versjoner er mye raskere enn eldre. Det er kjente problemer med NVIDIA-skjermkort og med WebGL som stille havner på en treg vei. Målingen bør gjøres med WebKitGTK 2.54 eller nyere.
- **Natural Earth:** Offentlig eiendom. Omstridte områder finnes i 1:10m og 1:50m, med synspunkt-varianter for over 30 land i 1:10m. Veier finnes bare i 1:10m, og det er uklart om de dekker hele verden. Byområder finnes i 1:10m og 1:50m, fra satellittdata fra 2002–2003. Relieff og høydefarger finnes som rasterbilder i 1:10m og 1:50m. Skog finnes bare som farge i rasterbildene.

## Bakgrunn

Valget av verktøy og bibliotek bygger på noen antakelser som var skrevet etter hukommelsen: hvilke lisenser de planlagte bibliotekene har, hva Tauri trenger av systempakker på Linux, hvor godt systemets nettlesermotor på Linux tegner på lerret, og hva Natural Earth har av kartlag. Dette notatet sjekker antakelsene mot kildene.

Regelen er at hver påstand har en lenke til en side som faktisk ble åpnet. Det som ikke lot seg bekrefte, er merket **ubekreftet**, med hva som ble prøvd. Det som er egen vurdering og ikke står i kilden, er merket **vurdering**.

Noen ord som går igjen:

- **Lisens:** vilkårene for å bruke, endre og dele et program.
- **Forenlig med GPL-3.0-or-later:** koden kan bygges sammen med vårt program, og helheten kan deles under GPL versjon 3.
- **Tillatende lisens** (MIT, BSD, ISC, Apache og lignende): krever i hovedsak bare at opphavsmerknaden følger med. Slike lisenser kan brukes i et GPL-program.
- **Copyleft** (GPL, LGPL, MPL): krever at endringer deles under samme vilkår.
- **SPDX-id:** en standard kortform for en lisens, for eksempel `MIT` eller `GPL-3.0-or-later`. Det er disse kortformene lisenskontrollen vår leser.
- **Utviklingsavhengighet:** et verktøy vi bruker når vi bygger og prøver programmet, men som ikke følger med programmet til brukerne.
- **Kjøreavhengighet:** noe som følger med programmet, eller som må være installert for at programmet skal virke.

## 1. Lisensene til de planlagte avhengighetene

Lisensen er lest i lisensfilen i kildekoden og, for npm-pakker, i lisensfeltet i pakkeregisteret (npm er stedet JavaScript-pakker lastes ned fra). Versjonsnummeret er den nyeste versjonen i registeret 2026-11-26.

FSF (Free Software Foundation, som skriver GPL) sier at tillatende lisenser som MIT (FSF kaller den «Expat»), ISC, BSD og Apache 2.0 er forenlige med GPL versjon 3 ([FSF-lisenslisten, Expat](https://www.gnu.org/licenses/license-list.html#Expat), [ISC](https://www.gnu.org/licenses/license-list.html#ISC), [Apache 2.0](https://www.gnu.org/licenses/license-list.html#apache2)). Det er grunnlaget for kolonnen «Forenlig» under.

### Verktøy for utvikling (følger ikke med programmet)

| Avhengighet       | Hva den gjør                                           | Lisens            | Forenlig | Kilder                                                                                                                                      |
| ----------------- | ------------------------------------------------------ | ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript 7.0.2  | JavaScript med typer, oversettes til vanlig JavaScript | Apache-2.0        | Ja       | [LICENSE.txt](https://raw.githubusercontent.com/microsoft/TypeScript/main/LICENSE.txt), [npm](https://registry.npmjs.org/typescript/latest) |
| pnpm 12.23.0      | Henter og holder orden på pakkene                      | MIT               | Ja       | [LICENSE](https://raw.githubusercontent.com/pnpm/pnpm/main/LICENSE), [npm](https://registry.npmjs.org/pnpm/latest)                          |
| Vite 8.4.0        | Bygger og serverer koden under utvikling               | MIT               | Ja       | [LICENSE](https://raw.githubusercontent.com/vitejs/vite/main/LICENSE), [npm](https://registry.npmjs.org/vite/latest)                        |
| Vitest 5.1.2      | Kjører enhetsprøver                                    | MIT               | Ja       | [LICENSE](https://raw.githubusercontent.com/vitest-dev/vitest/main/LICENSE), [npm](https://registry.npmjs.org/vitest/latest)                |
| Playwright 1.65.1 | Styrer en nettleser for å prøve hele programmet        | Apache-2.0        | Ja       | [LICENSE](https://raw.githubusercontent.com/microsoft/playwright/main/LICENSE), [npm](https://registry.npmjs.org/@playwright/test/latest)   |
| ESLint 10.15.0    | Finner feil og dårlig praksis i koden                  | MIT               | Ja       | [LICENSE](https://raw.githubusercontent.com/eslint/eslint/main/LICENSE), [npm](https://registry.npmjs.org/eslint/latest)                    |
| Prettier 3.10.1   | Formaterer koden likt                                  | MIT               | Ja       | [LICENSE](https://raw.githubusercontent.com/prettier/prettier/main/LICENSE), [npm](https://registry.npmjs.org/prettier/latest)              |
| Tauri CLI 2.12.6  | Kommandolinjeverktøyet som bygger skrivebordsappen     | Apache-2.0 OR MIT | Ja       | [npm](https://registry.npmjs.org/@tauri-apps/cli/latest)                                                                                    |

Merknad: Playwright laster ned egne nettlesere for prøvene. De brukes bare på utviklermaskinen og i prøvene på GitHub, og følger ikke med programmet (**vurdering**).

### Biblioteker som følger med programmet

| Avhengighet               | Hva den gjør                                                  | Lisens                                         | Forenlig       | Kilder                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------- | ---------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React 19.3.1              | Bygger redigeringsgrensesnittet                               | MIT                                            | Ja             | [LICENSE](https://raw.githubusercontent.com/facebook/react/main/LICENSE), [npm](https://registry.npmjs.org/react/latest)                                                                                                           |
| react-dom 19.3.1          | Kobler React til nettsiden                                    | MIT                                            | Ja             | [npm](https://registry.npmjs.org/react-dom/latest) (ligger i samme repo som React, under samme LICENSE)                                                                                                                            |
| Yjs 13.6.33               | Dokumentmodellen som fletter samtidige endringer              | MIT                                            | Ja             | [LICENSE](https://raw.githubusercontent.com/yjs/yjs/main/LICENSE), [npm](https://registry.npmjs.org/yjs/latest)                                                                                                                    |
| y-protocols 1.0.7         | Meldingsformatet Yjs bruker ved synk                          | MIT                                            | Ja             | [LICENSE](https://raw.githubusercontent.com/yjs/y-protocols/master/LICENSE), [npm](https://registry.npmjs.org/y-protocols/latest)                                                                                                  |
| y-websocket 3.1.0         | Klienten som synker Yjs over WebSocket (synk, senere)         | MIT                                            | Ja             | [LICENSE](https://raw.githubusercontent.com/yjs/y-websocket/master/LICENSE), [npm](https://registry.npmjs.org/y-websocket/latest)                                                                                                  |
| @y/websocket-server 0.1.5 | Tjenerdelen, som er flyttet ut av y-websocket (synk-tjeneren) | MIT                                            | Ja             | [README for y-websocket](https://raw.githubusercontent.com/yjs/y-websocket/master/README.md) sier at tjeneren «now lives in a forkable repository», [npm](https://registry.npmjs.org/@y/websocket-server/latest)                   |
| Konva 10.11.0             | Kandidat for tegnemotoren, tegner på canvas                   | MIT                                            | Ja             | [LICENSE](https://raw.githubusercontent.com/konvajs/konva/master/LICENSE), [npm](https://registry.npmjs.org/konva/latest)                                                                                                          |
| d3-geo 3.1.2              | Kartprojeksjoner                                              | ISC, og MIT for innbakt kode fra GeographicLib | Ja             | [LICENSE](https://raw.githubusercontent.com/d3/d3-geo/main/LICENSE), [npm](https://registry.npmjs.org/d3-geo/latest)                                                                                                               |
| fflate 0.8.3              | Lager og leser zip-arkiv (filformatet)                        | MIT                                            | Ja             | [LICENSE](https://raw.githubusercontent.com/101arrowz/fflate/master/LICENSE), [npm](https://registry.npmjs.org/fflate/latest)                                                                                                      |
| JSZip 3.10.2              | Alternativ for zip-arkiv                                      | MIT eller GPL-3.0-or-later, etter eget valg    | Ja             | [LICENSE.markdown](https://raw.githubusercontent.com/Stuk/jszip/main/LICENSE.markdown), [npm](https://registry.npmjs.org/jszip/latest)                                                                                             |
| Tauri 2.12.7 (kjernen)    | Skrivebordsskallet                                            | Apache-2.0 OR MIT                              | Ja             | [crates.io](https://crates.io/api/v1/crates/tauri), [repoet](https://github.com/tauri-apps/tauri) (lisensfilene `LICENSE-APACHE-2.0` og `LICENSE-MIT`), [README](https://raw.githubusercontent.com/tauri-apps/tauri/dev/README.md) |
| @tauri-apps/api 2.12.5    | JavaScript-siden av Tauri                                     | Apache-2.0 OR MIT                              | Ja             | [npm](https://registry.npmjs.org/@tauri-apps/api/latest)                                                                                                                                                                           |
| Electron 45.5.0           | Reserven for skrivebordsskallet                               | MIT                                            | Ja, se merknad | [LICENSE](https://raw.githubusercontent.com/electron/electron/main/LICENSE), [npm](https://registry.npmjs.org/electron/latest)                                                                                                     |
| better-sqlite3 13.2.0     | Kobler Node til SQLite (synk-tjeneren)                        | MIT                                            | Ja             | [LICENSE](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/LICENSE), [npm](https://registry.npmjs.org/better-sqlite3/latest)                                                                                       |
| node:sqlite               | SQLite innebygd i Node, uten ekstra pakke                     | Node-lisensen (MIT-lignende)                   | Ja             | [Node LICENSE](https://raw.githubusercontent.com/nodejs/node/main/LICENSE), [dokumentasjon](https://nodejs.org/api/sqlite.html)                                                                                                    |
| SQLite                    | Databasen tjeneren lagrer i                                   | Offentlig eiendom, trenger ingen lisens        | Ja             | [sqlite.org/copyright](https://www.sqlite.org/copyright.html), [FSF om offentlig eiendom](https://www.gnu.org/licenses/license-list.html#PublicDomain)                                                                             |
| WebKitGTK 2.54.3          | Systemets nettlesermotor på Linux, som Tauri tegner i         | LGPL 2 (eller senere) og BSD                   | Ja             | [webkit.org/licensing-webkit](https://webkit.org/licensing-webkit/), [webkitgtk.org](https://webkitgtk.org/) (versjon og dato)                                                                                                     |
| Natural Earth             | Grunndata for kart                                            | Offentlig eiendom                              | Ja             | [Vilkår for bruk](https://www.naturalearthdata.com/about/terms-of-use/)                                                                                                                                                            |

Merknader:

- **Tauri-logoen** har en annen lisens enn koden: README sier «Logo: CC-BY-NC-ND» ([README](https://raw.githubusercontent.com/tauri-apps/tauri/dev/README.md)). Den lisensen forbyr endringer og kommersiell bruk, og er ikke fri ([FSF om CC-BY-NC](https://www.gnu.org/licenses/license-list.html#CC-BY-NC), [CC-BY-ND](https://www.gnu.org/licenses/license-list.html#CC-BY-ND)). Logoen skal derfor ikke brukes i programmet eller på nettsiden vår.
- **node:sqlite** er merket «Stability: 1.2 - Release candidate» i Node-dokumentasjonen, og trenger ikke lenger noe eget flagg fra Node 22.13.0 og 23.4.0 ([dokumentasjon](https://nodejs.org/api/sqlite.html)). Det er altså nesten, men ikke helt, et stabilt grensesnitt. better-sqlite3 er alternativet.
- **SQLite i Node:** I den delen av Nodes lisensfil som ble lest, fant jeg ingen egen SQLite-del. Det spiller liten rolle, fordi SQLite er offentlig eiendom ([sqlite.org](https://www.sqlite.org/copyright.html)). **Ubekreftet:** om Nodes lisensfil har en egen SQLite-del; to deler av filen ble lest uten treff.
- **WebKit-siden** gjengir GNU Library General Public License versjon 2, med merknaden «version 2 of the License, or (at your option) any later version» ([webkit.org](https://webkit.org/licensing-webkit/)). Siden sier ikke hvilke deler som har hvilken lisens. Pakkene i distribusjonene oppgir en lang liste: Arch blant annet LGPL-2.1-or-later, BSD-3-Clause, MIT og MPL-2.0 ([Arch](https://archlinux.org/packages/extra/x86_64/webkit2gtk-4.1/)), Fedora blant annet LGPL-2.1-only, BSD, MIT, Apache-2.0, MPL-2.0 og GPL-3.0-or-later med unntak ([Fedora](https://packages.fedoraproject.org/pkgs/webkitgtk/webkit2gtk4.1/)). LGPL 2 og 2.1 er forenlige med GPL-3, se del 2. WebKitGTK brukes som systembibliotek og følger ikke med programmet på Linux.
- **Electron** tar med seg en hel Chromium-nettleser med mange underlisenser. Dem har jeg ikke gått gjennom. **Ubekreftet:** Chromiums underlisenser. Electron er bare reserve, så dette kan vente til det eventuelt blir aktuelt.
- **Rust-pakkene under Tauri:** Tauri trekker inn mange Rust-pakker (crates). Lisenskontrollen vår leser bare npm-pakker og ser dem ikke. Dette bør dekkes av en egen kontroll for Rust-avhengigheter når skrivebordsappen bygges (**vurdering**).
- **Avspilleren og det planlagte unntaket:** Avspilleren skal få et skriftlig unntak fra GPL, slik at eksporterte presentasjoner kan deles fritt. Et slikt unntak kan bare gis for kode vi selv har opphavsrett til. Bibliotek som bygges inn i avspilleren, bør derfor ha tillatende lisens (MIT, ISC, BSD, Apache, Zlib og lignende), ikke GPL eller LGPL (**vurdering**, bør tas med når ordlyden i unntaket skrives).

## 2. Kontroll av listene i lisenskontrollen

Lisenskontrollen (`scripts/lib/licenses.ts`) har to lister:

- **Produksjonslisten:** lisenser som er godtatt for bibliotek som følger med programmet. De må være forenlige med GPL-3.0-or-later.
- **Utviklingslisten:** lisenser som er godtatt for verktøy som bare brukes under utvikling. De må være frie, men trenger ikke være forenlige med GPL.

Filen sier selv at listene var skrevet etter hukommelsen og skulle kontrolleres i denne pakken.

### Kildene

- **FSF-lisenslisten** ([gnu.org/licenses/license-list.html](https://www.gnu.org/licenses/license-list.html), sist endret 2026-04-22 ifølge sidens datostempel). Hentet direkte fra gnu.org.
- **GPL FAQ** fra FSF. gnu.org svarte ikke på denne siden: fem forsøk med `curl` og ett med nettleserverktøyet ga tidsavbrudd eller brutt forbindelse. Jeg brukte derfor en kopi i Internet Archive tatt 2026-11-18: [web.archive.org/…/gpl-faq.html](https://web.archive.org/web/20261118023556/https://www.gnu.org/licenses/gpl-faq.html) (originalen: [gnu.org/licenses/gpl-faq.html](https://www.gnu.org/licenses/gpl-faq.html), datostempel i kopien 2026-01-13).
- **LGPL versjon 2.0** (GNU Library General Public License), også fra Internet Archive av samme grunn: [web.archive.org/…/lgpl-2.0.html](https://web.archive.org/web/20261116235309/https://www.gnu.org/licenses/old-licenses/lgpl-2.0.html), tatt 2026-11-16.
- **SPDX-lisenslisten** versjon 3.29.0 av 2026-09-16 ([spdx.org/licenses/licenses.json](https://spdx.org/licenses/licenses.json)). Den sier om en lisens er godkjent av OSI (Open Source Initiative) og om FSF regner den som fri. Den sier ikke noe om forenlighet med GPL.
- **Fedoras liste over tillatte lisenser** ([docs.fedoraproject.org/en-US/legal/allowed-licenses](https://docs.fedoraproject.org/en-US/legal/allowed-licenses/)), brukt der verken FSF eller OSI har en vurdering.

### Det viktigste

- **GPL-2.0-only og GPL-3.0 kan ikke kombineres.** FSF: «GPLv2 is, by itself, not compatible with GPLv3» ([FSF, GPLv2](https://www.gnu.org/licenses/license-list.html#GPLv2)). GPL FAQ: «if code is released under GPL “version 2 or later,” that is compatible with GPLv3 because GPLv3 is one of the options it permits» ([GPL FAQ, v2v3Compatibility](https://web.archive.org/web/20261118023556/https://www.gnu.org/licenses/gpl-faq.html#v2v3Compatibility)). Listene har dette riktig: GPL-2.0-or-later står på produksjonslisten, GPL-2.0-only bare på utviklingslisten.
- **Apache-2.0 er forenlig med GPL-3, men ikke med GPL-2.** FSF: «compatible with version 3 of the GNU GPL. Please note that this license is not compatible with GPL version 2» ([FSF, Apache 2.0](https://www.gnu.org/licenses/license-list.html#apache2)). Vi er GPL-3.0-or-later, så Apache-2.0 er i orden for oss.
- **MPL-2.0 er forenlig gjennom «Secondary License»-klausulen** (punkt 3.3), med ett unntak: kode merket «Incompatible With Secondary Licenses» er ikke forenlig med GPL ([FSF, MPL-2.0](https://www.gnu.org/licenses/license-list.html#MPL-2.0)). SPDX har en egen id for den varianten, `MPL-2.0-no-copyleft-exception` ([SPDX](https://spdx.org/licenses/MPL-2.0-no-copyleft-exception.html)), og den står ikke på listene. Men en pakke kan ha merknaden i filene sine og likevel oppgi bare `MPL-2.0`. Kontrollen ser ikke det.
- **LGPL-2.1 kan alltid brukes i et GPL-3-program.** I FAQ-ens tabell er både «copy code» og «use a library» under LGPLv2.1 merket OK for et prosjekt under «GPLv3 or later», fordi «LGPLv2.1 gives you permission to relicense the code under any version of the GPL since GPLv2» ([GPL FAQ, AllCompatibility](https://web.archive.org/web/20261118023556/https://www.gnu.org/licenses/gpl-faq.html#AllCompatibility), fotnote 7).
- **LGPL-2.0** står ikke i FAQ-tabellen eller som eget punkt i FSF-listen. Lisensteksten selv sier i punkt 3: «You may opt to apply the terms of the ordinary GNU General Public License instead of this License … (If a newer version than version 2 of the ordinary GNU General Public License has appeared, then you can specify that version instead if you wish.)» ([LGPL 2.0, punkt 3](https://web.archive.org/web/20261116235309/https://www.gnu.org/licenses/old-licenses/lgpl-2.0.html)). Koden kan altså gjøres om til GPL-3 og er forenlig.
- **LGPL-3.0** er «compatible with GPLv3» ([FSF, LGPLv3](https://www.gnu.org/licenses/license-list.html#LGPLv3)).
- **GPL-3.0-only** kan tas inn i et prosjekt under «GPLv3 or later» (FAQ-tabellen, raden «GPLv3», kolonnen «GPLv3 or later»: OK). Helheten kan da i praksis bare deles under GPL versjon 3 så lenge den koden er med (**vurdering**, samme logikk som fotnote 2 i tabellen).
- **CC-BY-4.0** er «compatible with all versions of the GNU GPL», men FSF sier at Creative Commons-lisenser ikke bør brukes på programvare ([FSF, CC BY](https://www.gnu.org/licenses/license-list.html#ccby)). Det stemmer med kommentaren i koden: godtatt for data, ikke kode.
- **CC-BY-3.0** har ingen egen vurdering hos FSF. FSF-listen omtaler bare versjon 4.0 av CC BY og CC BY-SA ([FSF, CC BY](https://www.gnu.org/licenses/license-list.html#ccby)). SPDX merker den verken som OSI-godkjent eller FSF-fri. Fedora godtar den for innhold, dokumentasjon og skrifter ([Fedora](https://docs.fedoraproject.org/en-US/legal/allowed-licenses/)). **Ubekreftet:** om CC-BY-3.0 er forenlig med GPL-3. Den står bare på utviklingslisten, og det er riktig.
- **Artistic-2.0** er forenlig «thanks to the relicensing option in section 4(c)(ii)» ([FSF, Artistic 2.0](https://www.gnu.org/licenses/license-list.html#ArtisticLicense2)).
- **Unicode-3.0** er «compatible with all versions of the GNU GPL» ([FSF, Unicode v3](https://www.gnu.org/licenses/license-list.html#Unicodev3)).
- **Zlib** er «compatible with the GPL» ([FSF, ZLib](https://www.gnu.org/licenses/license-list.html#ZLib)).
- **BlueOak-1.0.0** finnes ikke på FSF-listen (søk etter «Blue Oak» og «BlueOak» i sidens kildetekst ga null treff). Den er OSI-godkjent fra 19. januar 2024 ([OSI](https://opensource.org/license/blueoak-1-0-0)), og Fedora godtar den ([Fedora](https://docs.fedoraproject.org/en-US/legal/allowed-licenses/)). Lisensteksten nevner ikke GPL ([blueoakcouncil.org](https://blueoakcouncil.org/license/1.0.0)). **Ubekreftet:** forenlighet med GPL-3. Den er en kort tillatende lisens med patentlisens, og er trolig forenlig (**vurdering**), men det finnes ingen kilde fra FSF.
- **Python-2.0** er i SPDX «the overall Python license as published on the OSI website», altså PSF-lisensen med de eldre BeOpen-, CNRI- og CWI-avtalene etter ([SPDX, Python-2.0](https://spdx.org/licenses/Python-2.0.html)). FSF sier at lisensen til «Python 2.0.1, 2.1.1, and newer versions» er forenlig med GPL, men at Python 1.6b1 til 2.0 og 2.1 har en annen lisens som ikke er det ([FSF, Python](https://www.gnu.org/licenses/license-list.html#Python), [FSF, PythonOld](https://www.gnu.org/licenses/license-list.html#PythonOld)). At SPDX-id-en `Python-2.0` svarer til den forenlige lisensen og ikke den eldre, er en **vurdering** ut fra beskrivelsen hos SPDX; navnet «2.0» er lett å misforstå.
- **De korte tillatende lisensene:** MIT (FSF: Expat) ([FSF](https://www.gnu.org/licenses/license-list.html#Expat)), MIT-0 (FSF: Expat0, «Our comments about the Zero-clause BSD license apply») ([FSF](https://www.gnu.org/licenses/license-list.html#Expat0)), ISC ([FSF](https://www.gnu.org/licenses/license-list.html#ISC)), BSD-2-Clause (FSF: FreeBSD) ([FSF](https://www.gnu.org/licenses/license-list.html#FreeBSD)), BSD-3-Clause (FSF: Modified BSD) ([FSF](https://www.gnu.org/licenses/license-list.html#ModifiedBSD)), 0BSD («can operate as a free software license compatible with the GNU GPL») ([FSF](https://www.gnu.org/licenses/license-list.html#Zero-BSD)), Unlicense ([FSF](https://www.gnu.org/licenses/license-list.html#Unlicense)) og CC0-1.0 ([FSF](https://www.gnu.org/licenses/license-list.html#CC0)) er alle forenlige ifølge FSF. For CC0 advarer FSF om at den ikke gir patentlisens, og fraråder den for programvare.
- **Unntakene** (`WITH …`) gir bare ekstra tillatelser: Classpath-unntaket og GCC-unntaket gjelder kobling til GPL-bibliotek, og LLVM-unntaket gjelder kode som havner i kompilerte filer og kombinasjon med GPLv2 ([SPDX, Classpath-exception-2.0](https://spdx.org/licenses/Classpath-exception-2.0.html), [SPDX, GCC-exception-3.1](https://spdx.org/licenses/GCC-exception-3.1.html), [SPDX, LLVM-exception](https://spdx.org/licenses/LLVM-exception.html)). Kontrollen godtar et uttrykk med unntak bare når grunnlisensen er godtatt. Et unntak kan derfor ikke slippe gjennom noe grunnlisensen alene ikke ville sluppet gjennom (**vurdering**, lest i koden).

### Produksjonslisten, punkt for punkt

| SPDX-id                                               | Forenlig med GPL-3.0-or-later                                         | Kilde                                                                                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MIT                                                   | Ja                                                                    | [FSF, Expat](https://www.gnu.org/licenses/license-list.html#Expat)                                                                                                                         |
| MIT-0                                                 | Ja                                                                    | [FSF, Expat0](https://www.gnu.org/licenses/license-list.html#Expat0)                                                                                                                       |
| ISC                                                   | Ja                                                                    | [FSF, ISC](https://www.gnu.org/licenses/license-list.html#ISC)                                                                                                                             |
| BSD-2-Clause                                          | Ja                                                                    | [FSF, FreeBSD](https://www.gnu.org/licenses/license-list.html#FreeBSD)                                                                                                                     |
| BSD-3-Clause                                          | Ja                                                                    | [FSF, Modified BSD](https://www.gnu.org/licenses/license-list.html#ModifiedBSD)                                                                                                            |
| 0BSD                                                  | Ja                                                                    | [FSF, Zero-BSD](https://www.gnu.org/licenses/license-list.html#Zero-BSD)                                                                                                                   |
| Unlicense                                             | Ja                                                                    | [FSF, Unlicense](https://www.gnu.org/licenses/license-list.html#Unlicense)                                                                                                                 |
| CC0-1.0                                               | Ja                                                                    | [FSF, CC0](https://www.gnu.org/licenses/license-list.html#CC0)                                                                                                                             |
| BlueOak-1.0.0                                         | **Ubekreftet**                                                        | Ikke på FSF-listen. [OSI](https://opensource.org/license/blueoak-1-0-0), [Fedora](https://docs.fedoraproject.org/en-US/legal/allowed-licenses/)                                            |
| Python-2.0                                            | Ja, med forbehold om hvilken Python-lisens id-en dekker               | [FSF, Python](https://www.gnu.org/licenses/license-list.html#Python), [SPDX](https://spdx.org/licenses/Python-2.0.html)                                                                    |
| Zlib                                                  | Ja                                                                    | [FSF, ZLib](https://www.gnu.org/licenses/license-list.html#ZLib)                                                                                                                           |
| Unicode-3.0                                           | Ja                                                                    | [FSF, Unicode v3](https://www.gnu.org/licenses/license-list.html#Unicodev3)                                                                                                                |
| Artistic-2.0                                          | Ja                                                                    | [FSF, Artistic 2.0](https://www.gnu.org/licenses/license-list.html#ArtisticLicense2)                                                                                                       |
| Apache-2.0                                            | Ja (ikke med GPL-2.0-only)                                            | [FSF, Apache 2.0](https://www.gnu.org/licenses/license-list.html#apache2)                                                                                                                  |
| CC-BY-4.0                                             | Ja, for data                                                          | [FSF, CC BY](https://www.gnu.org/licenses/license-list.html#ccby)                                                                                                                          |
| MPL-2.0                                               | Ja, hvis filene ikke er merket «Incompatible With Secondary Licenses» | [FSF, MPL-2.0](https://www.gnu.org/licenses/license-list.html#MPL-2.0)                                                                                                                     |
| LGPL-2.0-only, LGPL-2.0-or-later, LGPL-2.0, LGPL-2.0+ | Ja, gjennom punkt 3 i lisensen                                        | [LGPL 2.0](https://web.archive.org/web/20261116235309/https://www.gnu.org/licenses/old-licenses/lgpl-2.0.html)                                                                             |
| LGPL-2.1-only, LGPL-2.1-or-later, LGPL-2.1, LGPL-2.1+ | Ja                                                                    | [FSF, LGPLv2.1](https://www.gnu.org/licenses/license-list.html#LGPLv2.1), [GPL FAQ](https://web.archive.org/web/20261118023556/https://www.gnu.org/licenses/gpl-faq.html#AllCompatibility) |
| LGPL-3.0-only, LGPL-3.0-or-later, LGPL-3.0, LGPL-3.0+ | Ja                                                                    | [FSF, LGPLv3](https://www.gnu.org/licenses/license-list.html#LGPLv3)                                                                                                                       |
| GPL-2.0-or-later, GPL-2.0+                            | Ja                                                                    | [GPL FAQ, v2v3Compatibility](https://web.archive.org/web/20261118023556/https://www.gnu.org/licenses/gpl-faq.html#v2v3Compatibility)                                                       |
| GPL-3.0-only, GPL-3.0-or-later, GPL-3.0, GPL-3.0+     | Ja                                                                    | [GPL FAQ, AllCompatibility](https://web.archive.org/web/20261118023556/https://www.gnu.org/licenses/gpl-faq.html#AllCompatibility)                                                         |

Id-ene uten `-only` eller `-or-later` (for eksempel `GPL-3.0` og `LGPL-2.1`) og id-ene med `+` er utgått i SPDX, men brukes fortsatt av eldre pakker ([SPDX-listen](https://spdx.org/licenses/licenses.json), feltet `isDeprecatedLicenseId`). `GPL-3.0` betyr «GPL-3.0-only» og `LGPL-2.0` betyr «LGPL-2.0-only». Begge er forenlige, så det er riktig å godta dem.

### Utviklingslisten, punkt for punkt

Her er spørsmålet bare om lisensen er fri. SPDX-listen oppgir om OSI har godkjent den («OSI») og om FSF regner den som fri («FSF») ([spdx.org/licenses/licenses.json](https://spdx.org/licenses/licenses.json)).

| SPDX-id                                    | Fri             | Kilde                                                                                                | Forenlig med GPL-3 (bare til orientering)                                                                                |
| ------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GPL-2.0-only, GPL-2.0                      | Ja (OSI, FSF)   | SPDX                                                                                                 | Nei ([FSF, GPLv2](https://www.gnu.org/licenses/license-list.html#GPLv2))                                                 |
| AGPL-3.0-only, AGPL-3.0-or-later, AGPL-3.0 | Ja (OSI, FSF)   | SPDX                                                                                                 | Ikke strengt, men separate moduler kan kombineres ([FSF, AGPL](https://www.gnu.org/licenses/license-list.html#AGPLv3.0)) |
| EPL-1.0                                    | Ja (OSI, FSF)   | SPDX                                                                                                 | Nei ([FSF, EPL](https://www.gnu.org/licenses/license-list.html#EPL))                                                     |
| EPL-2.0                                    | Ja (OSI, FSF)   | SPDX                                                                                                 | Nei, uten egen GPL-merking ([FSF, EPL2](https://www.gnu.org/licenses/license-list.html#EPL2))                            |
| CDDL-1.0                                   | Ja (OSI, FSF)   | SPDX                                                                                                 | Nei ([FSF, CDDL](https://www.gnu.org/licenses/license-list.html#CDDL))                                                   |
| CC-BY-3.0                                  | Ja, for innhold | [Fedora](https://docs.fedoraproject.org/en-US/legal/allowed-licenses/) (verken OSI eller FSF i SPDX) | Ubekreftet                                                                                                               |
| CC-BY-SA-3.0                               | Ja, for innhold | [Fedora](https://docs.fedoraproject.org/en-US/legal/allowed-licenses/) (verken OSI eller FSF i SPDX) | Ubekreftet                                                                                                               |
| CC-BY-SA-4.0                               | Ja (FSF)        | SPDX, [FSF, CC BY-SA](https://www.gnu.org/licenses/license-list.html#ccbysa)                         | Én vei, bare til GPL versjon 3                                                                                           |
| PSF-2.0                                    | Ja              | [Fedora](https://docs.fedoraproject.org/en-US/legal/allowed-licenses/) (verken OSI eller FSF i SPDX) | Trolig, se rettelse R4                                                                                                   |
| WTFPL                                      | Ja (FSF)        | SPDX, [FSF, WTFPL](https://www.gnu.org/licenses/license-list.html#WTFPL)                             | Ja                                                                                                                       |
| OFL-1.1                                    | Ja (OSI, FSF)   | SPDX, [FSF, SIL OFL](https://www.gnu.org/licenses/license-list.html#SILOFL)                          | FSF sier ikke noe om det                                                                                                 |

Alt på utviklingslisten er altså bekreftet fritt, av FSF, OSI eller Fedora. Rettelsene som følger av dette, står samlet i tabellen helt til slutt i notatet.

## 3. Hva Tauri 2 krever av systempakker på Linux

På Linux tegner Tauri i WebKitGTK, systemets nettlesermotor, og bruker GTK 3 til vinduer. Tauri 2 krever WebKitGTK med API-versjon 4.1. Tauri nevner Ubuntu 22.04 og Debian 12 som eksempler på eldre utgaver som har den, og anbefaler å bygge på den eldste utgaven man vil støtte ([Tauri, Debian](https://v2.tauri.app/distribute/debian/)).

### Til bygging (på utviklermaskinen og i GitHub)

Pakkenavnene er skrevet av ordrett fra Tauris side om forutsetninger ([v2.tauri.app/start/prerequisites](https://v2.tauri.app/start/prerequisites/)):

| Distribusjon     | Kommando og pakker                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debian og Ubuntu | `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`                                |
| Arch             | `sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool`                                     |
| Fedora           | `sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel` og `sudo dnf group install "c-development"` |

I tillegg trengs Rust og Node ([samme side](https://v2.tauri.app/start/prerequisites/)).

### Til kjøring (det en installert app trenger)

Tauris kommandolinjeverktøy legger selv inn avhengighetene i installasjonspakkene. Det står i kildekoden (`crates/tauri-cli/src/interface/rust.rs`, [kildefil](https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-cli/src/interface/rust.rs)):

| Pakkeformat          | Alltid med                                                                                        | Bare hvis appen har ikon i systemfeltet                       |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| deb (Debian, Ubuntu) | `libwebkit2gtk-4.1-0`, `libgtk-3-0`                                                               | `libayatana-appindicator3-1` eller `libappindicator3-1`       |
| Arch (pacman)        | `webkit2gtk-4.1`, `gtk3`                                                                          | `libayatana-appindicator` eller `libappindicator-gtk3`        |
| rpm (Fedora)         | bibliotekfilene `libwebkit2gtk-4.1.so.0` og `libgtk-3.so.0` (med `()(64bit)` på 64-bits maskiner) | `libayatana-appindicator3.so.1` eller `libappindicator3.so.1` |

For rpm oppgir Tauri altså navnet på bibliotekfilen, ikke pakkenavnet. Fedora-pakken som har WebKitGTK for GTK 3 og libsoup 3, heter `webkit2gtk4.1` ([Fedora-pakker](https://packages.fedoraproject.org/pkgs/webkitgtk/webkit2gtk4.1/)). At det er den som leverer `libwebkit2gtk-4.1.so.0`, sto ikke på pakkesiden. **Ubekreftet**, men trolig (**vurdering**).

Tauris egen side om Debian-pakker sier det samme som kildekoden: `libwebkit2gtk-4.1-0` og `libgtk-3-0`, og `libappindicator3-1` hvis appen bruker systemfeltet ([Tauri, Debian](https://v2.tauri.app/distribute/debian/)). Siden om rpm sier ikke hvilke avhengigheter som legges inn ([Tauri, RPM](https://v2.tauri.app/distribute/rpm/)).

Tauris mal for AUR (brukerpakkene på Arch) har en lengre liste: `cairo desktop-file-utils gdk-pixbuf2 glib2 gtk3 hicolor-icon-theme libsoup pango webkit2gtk-4.1` ([Tauri, AUR](https://v2.tauri.app/distribute/aur/)). Arch-pakken `webkit2gtk-4.1` avhenger av `libsoup3`, ikke `libsoup` ([Arch-pakker](https://archlinux.org/packages/extra/x86_64/webkit2gtk-4.1/)). `libsoup` i malen ser derfor ut til å være utdatert (**vurdering**).

### Hva som bare trengs til bygging

- Alle pakker som slutter på `-dev` eller `-devel`, og `build-essential`, `base-devel` og `c-development`. Det er overskrifter og verktøy for å kompilere ([forutsetninger](https://v2.tauri.app/start/prerequisites/)). Den installerte appen trenger bare biblioteket uten `-dev`, slik tabellen over viser.
- `curl`, `wget` og `file` står på listen over forutsetninger, men ikke blant kjøreavhengighetene i kildekoden. De trengs altså bare til bygging (**vurdering** ut fra at de mangler i kildekoden).
- `libxdo`/`xdotool`, `openssl` og `librsvg` står på listen over forutsetninger, men legges ikke inn som kjøreavhengigheter av Tauri. **Ubekreftet:** om appen vår vil trenge noen av dem ved kjøring. Det avhenger av hvilke funksjoner i Tauri vi bruker, og bør sjekkes med `ldd` på den ferdige appen når skrivebordsskallet bygges.

### Versjonene som finnes nå

WebKitGTK 2.54.3 kom 18. november 2026 ([webkitgtk.org](https://webkitgtk.org/)). Den versjonen ligger nå i Arch ([Arch](https://archlinux.org/packages/extra/x86_64/webkit2gtk-4.1/)), i Debian 13 «trixie» ([Debian](https://packages.debian.org/stable/libwebkit2gtk-4.1-0)) og i Fedora Rawhide og 45, mens Fedora 43 og 44 har 2.54.2 ([Fedora](https://packages.fedoraproject.org/pkgs/webkitgtk/webkit2gtk4.1/)). Debian- og Arch-pakkene avhenger av libsoup 3.

Dette passer med prosjektets krav om at systembibliotek skal være avhengigheter på Linux: i deb-, rpm- og Arch-pakkene er WebKitGTK og GTK oppført som avhengigheter, ikke lagt inn i pakken (kildekoden over). AppImage, som er et annet format, tar med seg bibliotekene; Tauri skriver at filen da vokser fra 2–6 MB til over 70 MB ([Tauri, AppImage](https://v2.tauri.app/distribute/appimage/)). AppImage bør derfor ikke være hovedformatet på Linux (**vurdering**).

## 4. Kjente begrensninger for canvas i WebKitGTK

Det finnes ingen samlet oversikt fra WebKit over hvor raskt canvas er på Linux. Det som finnes, er utgivelsesnotater, Tauris egen feilsøkingsside og feilrapporter. Rapportene er av ulik alder, og WebKitGTK har endret tegningen mye siden 2024, så de eldste kan være utdatert.

### Hva som er endret i WebKitGTK

- **2.46 (september 2024):** «Use Skia instead of cairo for 2D rendering and enable GPU rendering by default» og «Add a new setting to enable or disable the 2D canvas acceleration (enabled by default)» ([WebKitGTK 2.46.0](https://webkitgtk.org/2024/09/17/webkitgtk2.46.0-released.html)).- **2.52 (mars 2026):** «2D-canvas acceleration has now improved performance, as operations are recorded for batched replay» og «Text rendering has better performance too» ([WebKitGTK 2.52](https://webkitgtk.org/2026/03/18/webkitgtk-2.52-highlights.html)).
- **2.54 (september 2026):** ny sammensetter bygd på Skia i stedet for TextureMapper, og «the option to use Cairo for 2D rendering has been removed». I GTK3-utgaven brukes maskinvareakselerasjon nå alltid ([WebKitGTK 2.54](https://webkitgtk.org/2026/09/16/webkitgtk-2.54-highlights.html)).

### Kjente problemer

- **Tauris egen side om grafikkproblemer på Linux** (sist endret 25. november 2026) sier at oppsett med NVIDIA-skjermkort oftest gir problemer, fra blankt vindu til flimring og krasj ved endring av vindusstørrelse. Den gir en rekke miljøvariabler som omveier, der de siste slår av den raske tegnemåten ([Tauri, Linux Graphics Issues](https://v2.tauri.app/develop/debug/linux-graphics/)).
- **Samme side om WebGL og canvas:** Innhold kan havne på en treg vei uten feilmelding. Å lage en WebGL2-kontekst lykkes selv om den tegnes i programvare, og WebKitGTK skjuler hvilket skjermkort som brukes («reports Apple GPU on every Linux machine»). Tauri anbefaler en reserve uten WebGL på Linux og en innstilling brukeren kan slå om ([Tauri, Linux Graphics Issues](https://v2.tauri.app/develop/debug/linux-graphics/)).
- **NVIDIA-problemene** er samlet i Tauri-sak #9394, åpnet april 2024 og fortsatt åpen. Den nevner også at nyere WebKitGTK med WebGL2 ikke kjørte WebGL på X11 med NVIDIA, mens Wayland virket. Siste kommentar er fra januar 2026 ([tauri#9394](https://github.com/tauri-apps/tauri/issues/9394)).
- **Treg canvas-animasjon (desember 2022):** En canvas-animasjon falt til rundt 5 bilder i sekundet i Tauri, mot 17 til 30 i Brave og Chromium. GNOME Web (som også bruker WebKitGTK) var like treg. Lukket som et problem i WebKitGTK som Tauri ikke kunne gjøre noe med ([tauri#5761](https://github.com/tauri-apps/tauri/issues/5761)). Gjelder WebKitGTK fra før Skia, og kan være utdatert.
- **Generelt treg ytelse på Linux (2022 til 2025):** Saken startet med tusenvis av DOM-elementer i 2022 (WebKitGTK 2.36.1). Senere kommentarer melder om blant annet rundt 2 bilder i sekundet for en WebGL-app med Three.js på Ubuntu og Arch (juli 2025). En vedlikeholder skrev i april 2022 at akselerert 2D-canvas alt er slått på, og i april 2025 at planene om å erstatte eller gi alternativer til WebKitGTK går sakte, og at overgang til GTK4 er på vei som et mellomsteg. Siste kommentar er fra oktober 2025 ([tauri#3988](https://github.com/tauri-apps/tauri/issues/3988)).
- **Tilbakefall i én versjon (2023):** WebKitGTK 2.40.1 gjorde en Tauri-app treg. Problemet forsvant i 2.42.1 ([tauri#7021](https://github.com/tauri-apps/tauri/issues/7021)). Det viser at ytelsen kan variere mye mellom versjoner.
- **Versjonen betyr mye (oktober 2026):** En app med WebKitGTK innebygd fra Ubuntu 22.04 fikk 5,8 bilder i sekundet på en prøveside med skygger, mot 15,3 med Ubuntu 24.04 sin 2.52.6 og 60,1 med Arch sin 2.54.1, på samme maskin (NVIDIA RTX 3080, Wayland). Forskjellen lå i tegningen, ikke i JavaScript ([happier#584](https://github.com/happier-dev/happier/issues/584)). Dette er én rapport fra ett annet prosjekt, men den peker i samme retning som utgivelsesnotatene: nyere WebKitGTK er mye raskere.

### Hva dette betyr for valget av tegnemotor (vurdering)

- Ytelsesmålingen i skrivebordsskallet bør skje med WebKitGTK 2.54 eller nyere, og versjonen bør noteres sammen med tallene. Tall fra eldre versjoner sier lite om det brukerne får.
- Brukere på eldre utgaver av Ubuntu kan ha eldre og tregere WebKitGTK enn Arch og Fedora; rapporten over målte 2.52.6 på Ubuntu 24.04. Hvilken versjon Debian 12 og Ubuntu 22.04 har i dag, er ikke sjekket. Det bør vurderes hvilken eldste versjon vi støtter.
- Tegnemotorer basert på egen canvas-tegning eller nettleserens egne elementer bør ikke kreve WebGL. Om WebGL brukes, trengs en reserve, slik Tauri selv anbefaler.
- Maskiner med NVIDIA-skjermkort bør være med i prøvingen hvis mulig.
- Electron er reserven for skrivebordsskallet. Den har med egen Chromium og er ikke avhengig av WebKitGTK.

## 5. Natural Earth: lag for omstridte områder, veier, byområder og relieff

Natural Earth har data i tre detaljnivåer: 1:10m (mest detaljert, «Suitable for making zoomed-in maps of countries and regions»), 1:50m og 1:110m («schematic maps of the world on a postcard») ([Natural Earth, Downloads](https://www.naturalearthdata.com/downloads/)). Lagene finnes som vektordata (linjer og flater) og rasterdata (bilder). De fleste kulturlagene har versjon 5.1.1 eller 5.1.2 på nedlastingssidene.

### Vilkår for bruk

«All versions of Natural Earth raster + vector map data found on this website are in the public domain.» Kreditering er ikke nødvendig («Crediting the authors is unnecessary»), men de foreslår «Made with Natural Earth» ([vilkår](https://www.naturalearthdata.com/about/terms-of-use/)). Siden fraskriver seg ansvar for nøyaktighet og innhold, men sier ingenting særskilt om omstridte grenser ([vilkår](https://www.naturalearthdata.com/about/terms-of-use/)). Det betyr at grunndataene kan følge med programmet uten lisensplikter.

### Omstridte områder og grenselinjer

Natural Earth viser grensene slik de faktisk kontrolleres («de facto»), ikke slik de er fastsatt i lov («de jure») ([1:10m kultur](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/)).

| Lag                                                             | 1:10m                                | 1:50m | 1:110m |
| --------------------------------------------------------------- | ------------------------------------ | ----- | ------ |
| Omstridte områder og utbryterområder (flater)                   | Ja, også en utgave med «scale ranks» | Ja    | Nei    |
| Grenselinjer for omstridte områder                              | Ja                                   | Ja    | Nei    |
| Landegrenser på land                                            | Ja                                   | Ja    | Ja     |
| Landenes krav i Antarktis (flater og grenselinjer)              | Ja                                   | Nei   | Nei    |
| Land sett fra et bestemt lands synspunkt («point-of-view», POV) | Ja, i over 30 varianter              | Nei   | Nei    |

Kilder: [1:10m kultur](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/), [1:50m kultur](https://www.naturalearthdata.com/downloads/50m-cultural-vectors/), [1:110m kultur](https://www.naturalearthdata.com/downloads/110m-cultural-vectors/).

- Laget for omstridte områder i 1:10m har omtrent 100 objekter, «Kashmir to the Elemi Triangle», og nevner også Nord-Kypros og Vest-Sahara ([omstridte områder](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-0-breakaway-disputed-areas/)).
- POV-variantene viser landene «according to de jure boundaries (as prescribed by the home country’s law and/or local conventions)» for blant andre Kina, India, Pakistan, Russland, Tyrkia, Hellas, Israel, Palestina, Marokko, Taiwan og Storbritannia ([1:10m kultur](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/)). I tillegg har grenselagene felt (`fclass_*`) som styrer hvilke grenser som vises for hvert synspunkt ([1:50m kultur](https://www.naturalearthdata.com/downloads/50m-cultural-vectors/)).
- Endringsoversikten viser at laget holdes ved like: ny geometri for Krim i versjon 4.0.0, Donbas delt opp og Siachen-breen lagt til i 5.0.1, Sir Creek og Nord-Borneo i 5.1.0 ([CHANGELOG](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/CHANGELOG)).

For kartfunksjonen betyr det at et omstridt område kan hentes ferdig fra 1:10m og 1:50m, og at brukeren kan velge synspunkt i 1:10m (**vurdering**).

### Veier

| Lag                                   | 1:10m                        | 1:50m | 1:110m |
| ------------------------------------- | ---------------------------- | ----- | ------ |
| Veier                                 | Ja (versjon 5.0.0, 8,66 MB)  | Nei   | Nei    |
| Tilleggsdata for veier i Nord-Amerika | Ja (versjon 4.0.0, 45,57 MB) | Nei   | Nei    |
| Jernbane                              | Ja                           | Nei   | Nei    |

Kilder: [1:10m kultur](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/), [veier](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/roads/), [1:50m kultur](https://www.naturalearthdata.com/downloads/50m-cultural-vectors/).

Kildene er uenige om hvor veilaget dekker:

- Nedlastingssiden og README-filen for veier sier: «The “basic” is only available in North America due to the source. We’d like to expand this to world wide» ([veier](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/roads/), [README](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/10m_cultural/ne_10m_roads.README.html)).
- Endringsoversikten sier at versjon 2.0.0 «adds global roads, railroads, ports, airports, and time zones» ([CHANGELOG](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/CHANGELOG)).

**Ubekreftet:** om veilaget dekker hele verden i dag. Teksten på nedlastingssiden ser ut til å stamme fra før versjon 2.0.0 (**vurdering**). Det avgjøres enklest ved å laste ned og åpne dataene. Uansett er veilaget grovt: bare hovedveier, og bare i 1:10m.

### Byområder

| Lag                                 | 1:10m                        | 1:50m | 1:110m |
| ----------------------------------- | ---------------------------- | ----- | ------ |
| Byområder (flater)                  | Ja (versjon 4.0.0, 12,49 MB) | Ja    | Nei    |
| Befolkede steder (punkter med navn) | Ja                           | Ja    | Ja     |

Kilder: [1:10m kultur](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/), [1:50m kultur](https://www.naturalearthdata.com/downloads/50m-cultural-vectors/), [1:110m kultur](https://www.naturalearthdata.com/downloads/110m-cultural-vectors/).

Byområdene er «Derived from 2002-2003 MODIS satellite data at 1 km resolution» ([byområder](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-urban-area/)). De er altså over 20 år gamle og har en oppløsning på én kilometer. Det holder for å fargelegge byer på et kart over et land eller en region, men ikke for et utsnitt på noen få kilometer (**vurdering**).

### Relieff og høydefarger (rasterbilder)

| Lag                                                                         | 1:10m                                     | 1:50m                | 1:110m |
| --------------------------------------------------------------------------- | ----------------------------------------- | -------------------- | ------ |
| Skyggerelieff i gråtoner («Shaded Relief»)                                  | Ja, stor (42,31 MB) og middels (24,01 MB) | Ja, liten (10,85 MB) | Nei    |
| Høydefarger, «Cross-blended Hypsometric Tints», med og uten relieff og vann | Ja                                        | Ja                   | Nei    |
| Natural Earth I og II, med og uten relieff og vann                          | Ja                                        | Ja                   | Nei    |
| Gray Earth                                                                  | Ja                                        | Ja                   | Nei    |
| Havbunn («Ocean Bottom»)                                                    | Ja                                        | Ja                   | Nei    |
| Havdyp i rasterform («Bathymetry»)                                          | Nei                                       | Ja                   | Nei    |
| Håndtegnet skyggerelieff («Manual Shaded Relief»)                           | Bare for USA uten Alaska og Hawaii        | Ja                   | Nei    |
| «Prisma Shaded Relief»                                                      | Nei                                       | Ja                   | Nei    |

Kilder: [1:10m raster](https://www.naturalearthdata.com/downloads/10m-raster-data/), [1:50m raster](https://www.naturalearthdata.com/downloads/50m-raster-data/), [1:110m raster](https://www.naturalearthdata.com/downloads/110m-raster-data/) (siden lister ingen rasterlag), [1:10m skyggerelieff](https://www.naturalearthdata.com/downloads/10m-raster-data/10m-shaded-relief/), [1:50m skyggerelieff](https://www.naturalearthdata.com/downloads/50m-raster-data/50m-shaded-relief/).

- Skyggerelieffet er «derived from downsampled SRTM Plus elevation data clipped to the 10 million-scale Natural Earth coastline. A flat gray tint fills water areas» ([1:10m skyggerelieff](https://www.naturalearthdata.com/downloads/10m-raster-data/10m-shaded-relief/)).
- Høydefargene er laget slik at fargen følger naturen i området: «The Sahara is dusty brown, northern Russia is boreal forest green» ([høydefarger 1:10m](https://www.naturalearthdata.com/downloads/10m-raster-data/10m-cross-blend-hypso/)).
- Natural Earth II viser verden «in an idealized manner with little human influence», der byer er gjort om til skog, og passer derfor til historiske kart ([Natural Earth II](https://www.naturalearthdata.com/downloads/10m-raster-data/10m-natural-earth-2/)).
- Rasterlagene har versjon 3.2.0 ([1:10m skyggerelieff](https://www.naturalearthdata.com/downloads/10m-raster-data/10m-shaded-relief/)).
- **Ubekreftet:** hvor mange bildepunkter «stor» og «middels» har. Sidene oppgir bare filstørrelse.

### Skog

Listen over fysiske vektorlag i 1:10m har ikke noe skoglag: den har kystlinje, land, øyer, rev, hav, elver, innsjøer, navn, saltsletter, isbremmer i Antarktis, isbreer, havdyp, geografiske linjer og gradnett ([1:10m fysisk](https://www.naturalearthdata.com/downloads/10m-physical-vectors/)). Skog finnes bare som farge i rasterbildene (høydefargene og Natural Earth I og II).

### Hva Natural Earth gir og ikke gir for en kartredigerer

- Grunndataene er offentlig eiendom og kan følge med programmet uten lisensplikter.
- Omstridte områder og grenselinjer finnes ferdig i 1:10m og 1:50m, med synspunkt-varianter i 1:10m.
- Veier finnes bare i 1:10m, og bare hovedveier. Om de dekker hele verden, er ubekreftet (se over).
- Byområder finnes som flater med 1 km oppløsning fra 2002–2003, i 1:10m og 1:50m.
- Skog finnes ikke som vektorlag, bare som farge i rasterbildene.
- Relieff finnes som skyggerelieff og høydefarger i rasterform i 1:10m og 1:50m, ikke i 1:110m.
- Historiske grenser finnes ikke i lagene som er gjennomgått her (**vurdering**: ingen av nedlastingssidene lister slike lag).

## 6. Det som ikke lot seg bekrefte

| Påstand                                                                                       | Hva jeg prøvde                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CC-BY-3.0 og CC-BY-SA-3.0 er forenlige med GPL-3                                              | FSF-listen omtaler bare versjon 4.0. SPDX har ikke merket dem som OSI- eller FSF-godkjent. Fedora godtar dem som frie for innhold, men sier ikke noe om GPL.                                             |
| BlueOak-1.0.0 er forenlig med GPL-3                                                           | Søkte i kildeteksten til FSF-listen (null treff), leste lisensteksten, OSI-siden og Fedora-listen. Ingen av dem sier noe om GPL.                                                                         |
| SPDX-id-en `Python-2.0` er den samme lisensen som FSF kaller «Python 2.0.1, 2.1.1, and newer» | SPDX beskriver den som den samlede Python-lisensen fra OSI. Jeg har ikke sammenlignet teksten ord for ord med FSF sin.                                                                                   |
| Veilaget i Natural Earth dekker hele verden                                                   | Nedlastingssiden og README sier bare Nord-Amerika, endringsoversikten sier «global roads» fra 2.0.0. Dataene er ikke lastet ned og åpnet.                                                                |
| Antall bildepunkter i rasterlagene til Natural Earth                                          | Sidene oppgir bare filstørrelse.                                                                                                                                                                         |
| Fedora-pakken `webkit2gtk4.1` leverer `libwebkit2gtk-4.1.so.0`                                | Pakkesiden på packages.fedoraproject.org nevner ikke filnavnet.                                                                                                                                          |
| Om en Tauri-app trenger `libxdo`, `openssl` eller `librsvg` ved kjøring                       | De står på listen over forutsetninger for bygging, men ikke blant kjøreavhengighetene i Tauris kildekode. Avgjøres med `ldd` på en ferdig app.                                                           |
| Om Nodes lisensfil har en egen del for SQLite                                                 | Leste to deler av filen uten treff. Uten betydning, fordi SQLite er offentlig eiendom.                                                                                                                   |
| Underlisensene til Chromium i Electron                                                        | Ikke undersøkt. Electron er bare reserve.                                                                                                                                                                |
| GPL FAQ og LGPL 2.0 direkte fra gnu.org                                                       | gnu.org svarte på lisenslisten, men ga tidsavbrudd eller brutt forbindelse på disse to sidene ved gjentatte forsøk (seks for GPL FAQ). Brukte kopier fra Internet Archive tatt 2026-11-16 og 2026-11-18. |

## 7. Rettelser til lisenslistene

Gjelder `scripts/lib/licenses.ts`. «Må» betyr at listen er feil eller ufullstendig. «Bør» og «kan» er forslag.

| Nr. | Liste                | Oppføring                                                     | Funn                                                                                                                                                                                                                                                                   | Forslag                                                                                                                                                              | Grad                      |
| --- | -------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| R1  | Produksjon           | `BlueOak-1.0.0`                                               | Forenlighet med GPL-3 er ubekreftet. Ikke på FSF-listen. OSI-godkjent og godtatt av Fedora, men ingen av dem sier noe om GPL.                                                                                                                                          | Flytt til utviklingslisten til en kilde bekrefter forenlighet, eller behold med en kommentar om at den er godtatt etter skjønn. Avgjøres av orkestratoren.           | Bør                       |
| R2  | Produksjon           | `Python-2.0`                                                  | Forenlig ifølge FSF («License of Python 2.0.1, 2.1.1, and newer versions»). Navnet er lett å forveksle med Python 1.6b1–2.1-lisensen, som FSF sier er uforenlig.                                                                                                       | Behold. Skriv i kommentaren at id-en er den samlede Python-lisensen, og lenk til FSF.                                                                                | Kan                       |
| R3  | Produksjon           | `MPL-2.0`                                                     | Forenlig, men ikke for filer merket «Incompatible With Secondary Licenses». Kontrollen ser ikke den merknaden. SPDX-id-en `MPL-2.0-no-copyleft-exception` er riktignok avvist, fordi den ikke står på listen.                                                          | Behold. Legg til en kommentar om at MPL-pakker i produksjon må sjekkes for merknaden for hånd.                                                                       | Bør                       |
| R4  | Utvikling            | `PSF-2.0`                                                     | Står bare på utviklingslisten, mens `Python-2.0`, som inneholder PSF-lisensen, står på produksjonslisten. FSF regner Python-lisensen som forenlig.                                                                                                                     | Flytt til produksjonslisten, eller la stå og noter at det er bevisst. Flyttingen er en **vurdering**: FSF omtaler den samlede Python-lisensen, ikke PSF-delen alene. | Kan                       |
| R5  | Utvikling            | `WTFPL`                                                       | FSF: «compatible with the GNU GPL».                                                                                                                                                                                                                                    | Kan flyttes til produksjonslisten.                                                                                                                                   | Kan                       |
| R6  | Mangler i produksjon | `X11`, `BSL-1.0`                                              | FSF sier begge er forenlige ([X11](https://www.gnu.org/licenses/license-list.html#X11License), [Boost](https://www.gnu.org/licenses/license-list.html#boost)).                                                                                                         | Legg til når en avhengighet trenger dem.                                                                                                                             | Kan                       |
| R7  | Mangler i produksjon | `Unicode-DFS-2016`                                            | Den eldre Unicode-lisensen. FSF sier Unicode-lisensen for datafiler er «compatible with all versions of the GPL» ([FSF, Unicode](https://www.gnu.org/licenses/license-list.html#Unicode)). At FSF-oppføringen er akkurat 2016-utgaven, er en **vurdering**.            | Legg til når en avhengighet trenger den.                                                                                                                             | Kan                       |
| R8  | Mangler i produksjon | `AGPL-3.0-only`, `AGPL-3.0-or-later`                          | Ikke på produksjonslisten. Det er riktig for programmet. Synk-tjeneren skal være AGPL-3.0-or-later, og der er AGPL-avhengigheter i orden. FSF: AGPL og GPL kan kombineres som separate moduler ([FSF, AGPL](https://www.gnu.org/licenses/license-list.html#AGPLv3.0)). | Ingen endring nå. Vurder egen policy for `packages/server` når synk-tjeneren lages.                                                                                  | Kan                       |
| R9  | Utvikling            | `CC-BY-3.0`, `CC-BY-SA-3.0`, `PSF-2.0`                        | Fri ifølge Fedora. Ikke merket som OSI- eller FSF-godkjent i SPDX.                                                                                                                                                                                                     | Behold. Skriv i kommentaren at kilden for at de er frie, er Fedora-listen.                                                                                           | Kan                       |
| R10 | Utvikling            | `OFL-1.1`                                                     | Fri (OSI, FSF). FSF sier ikke om den er forenlig med GPL. Riktig på utviklingslisten. Skrifter som skal følge med programmet, må vurderes for seg.                                                                                                                     | Behold. Noter at skrifter i programmet krever egen avgjørelse.                                                                                                       | Kan                       |
| R11 | Produksjon           | `CC0-1.0`                                                     | Forenlig. FSF advarer om at CC0 ikke gir patentlisens og fraråder den for programvare.                                                                                                                                                                                 | Behold.                                                                                                                                                              | –                         |
| R12 | Produksjon           | `GPL-3.0-only`, `GPL-3.0`                                     | Forenlig. Så lenge slik kode er med, kan helheten i praksis bare deles under GPL versjon 3.                                                                                                                                                                            | Behold. Noter dette i kommentaren.                                                                                                                                   | Kan                       |
| R13 | Produksjon           | `LGPL-2.0-only`, `LGPL-2.0-or-later`, `LGPL-2.0`, `LGPL-2.0+` | Forenlig gjennom punkt 3 i LGPL 2.0 (kan gjøres om til GPL versjon 2 eller nyere).                                                                                                                                                                                     | Behold. Lenk til punkt 3 i kommentaren.                                                                                                                              | –                         |
| R14 | Begge                | Kommentaren øverst                                            | Sier at alt er skrevet etter hukommelsen og ubekreftet.                                                                                                                                                                                                                | Bytt ut med en henvisning til dette notatet, og merk R1 som fortsatt ubekreftet.                                                                                     | Bør                       |
| R15 | Utenfor listene      | Rust-pakker                                                   | Tauri trekker inn Rust-pakker som npm-kontrollen ikke ser.                                                                                                                                                                                                             | Legg til en lisenskontroll for Rust-avhengigheter når skrivebordsappen bygges.                                                                                       | Bør                       |
| R16 | Utenfor listene      | Avspilleren                                                   | Det planlagte unntaket for avspilleren kan bare gjelde vår egen kode.                                                                                                                                                                                                  | Vurder en strengere liste for avspilleren: bare tillatende lisenser, ikke GPL eller LGPL.                                                                            | Bør, før unntaket skrives |

Ingen oppføring på produksjonslisten er funnet å være feil, det vil si uforenlig med GPL-3. Alle oppføringene på utviklingslisten er bekreftet som frie.
