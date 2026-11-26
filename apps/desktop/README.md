# @galatsa/desktop: measurement shell (prototype)

A minimal Tauri 2 app that runs the rendering-engine benchmark (`bench/`) in the operating system's own web view, once with each of the three engine prototypes (`apps/proto-konva`, `apps/proto-canvas`, `apps/proto-dom`), samples the memory of the whole app from outside the page, and saves the results to a folder. It is a throwaway prototype for choosing an engine, not the Galatsa desktop app. The guide for the people who run it, in Norwegian, is [MAALING.md](MAALING.md).

## What it does

The start screen (`index.html`, `src/start.ts`) has a button that runs all three engines and one button per engine. Each engine runs in a freshly loaded page (`run.html`, `src/run.ts`), so that memory left behind by one engine does not count against the next: first a capture run (images of the stage at each hold; it also warms up fonts, decoders and code; never valid for decisions), then two timing runs. After the last engine the start screen shows a summary and where the files are.

Results go to `<Documents>/Galatsa-maaling/<date>_<time>_<platform>/`:

| File                                         | Contents                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<platform>-<engine>-<n>-<mode>.json`        | One run (`format: "galatsa-bench-shell-run"`, version 1): the bench result (format v3) under `result`, with capture images replaced by file names; `host` (OS, CPU, GPUs, memory, power, web view engine and version); `page` (window size, devicePixelRatio, screen, WebGL renderer); `hostMemory` (see below) |
| `<platform>-<engine>-capture-NN-<label>.png` | The capture images of the capture run (Konva and canvas engines; the DOM engine cannot read back what it draws, and the app takes no screenshots)                                                                                                                                                               |
| `summary.json`, `summary.txt`                | Per engine and run: the verdict on each target, validity and problems, the memory peak, and whether the two timing runs agree                                                                                                                                                                                   |

Engine ids: `konva`, `canvas2d`, `dom` (the DOM prototype's candidate variant). Platform: `linux`, `macos` or `windows`.

The refresh rate in the results is the one the bench measured (`verdictInputs.refreshRateHz`); the app does not ask the operating system.

## Memory

The bench judges the memory target only by the host's sampler (`setMemorySampler`). The app samples every 250 ms through the `memory_sample` command (`src-tauri/src/memory.rs`, run off the main thread). What each operating system offers differs, so the figures are not strictly comparable across systems:

| System  | Processes                                                                                                                                                                                                                                 | Figure per process                                                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux   | The app and all its descendants (WebKitWebProcess, WebKitNetworkProcess, any other WebKitGTK helper), from `/proc`                                                                                                                        | PSS from `/proc/<pid>/smaps_rollup` (shared pages divided between the processes that share them, so the sum counts nothing twice); RSS where PSS is refused |
| macOS   | The app and the WebKit processes it is responsible for (com.apple.WebKit.WebContent, .Networking, .GPU are XPC services started by launchd, not children), found with `responsibility_get_pid_responsible_for_pid`, looked up at run time | Physical footprint (`proc_pid_rusage`, what Activity Monitor shows as "Memory"); resident size where refused                                                |
| Windows | The app and all its descendants (msedgewebview2.exe)                                                                                                                                                                                      | Working set (resident memory); pages shared between the processes count more than once, so the sum is on the high side                                      |

If the web view's page process cannot be found or read, the sample has no total and the run's memory target is "cannot judge" (`null`) rather than a partial figure; `hostMemory.problems` says why. Memory on a dedicated graphics card is not included anywhere. The macOS method has not been tried on a Mac yet: whether macOS lets the app read the WebContent process is exactly what the first Mac run will show.

## Text and translations

The start screen and the progress line use `@galatsa/i18n` (namespace `desktop`, `src/messages/`), so the package is a user interface package and every script under `src/` is checked for hard-coded text. The harness's own controls below the stage come from `bench` and are in English. The window title and product name are in `tauri.conf.json`.

## Building and running

Needs the Tauri prerequisites ([v2.tauri.app/start/prerequisites](https://v2.tauri.app/start/prerequisites/); for Linux see [docs/adr/0002-kontroll-av-forutsetninger.md](../../docs/adr/0002-kontroll-av-forutsetninger.md)) and Rust 1.90 or newer.

```sh
pnpm --filter @galatsa/desktop tauri dev                 # development, with the Vite dev server
pnpm --filter @galatsa/desktop tauri build --no-bundle   # release program file only
pnpm --filter @galatsa/desktop tauri build --bundles deb # Debian/Ubuntu package
```

`pnpm build` at the root only builds the pages (`dist/`), not the Rust program, so the repository's own checks do not need Rust or WebKitGTK.

On Linux, measure with the system's WebKitGTK: the plain program file and the deb package use it; the AppImage carries its own, older copy and is only a way to see that the app starts. On Arch, build the program file from source (command above) and run `src-tauri/target/release/galatsa-bench-shell`.

Environment variables for automated runs: `GALATSA_RESULTS_DIR` (results root), `GALATSA_PLATFORM_LABEL` (label in names, for example `linux-xvfb`), `GALATSA_AUTORUN` (`all` or an engine id) and `GALATSA_EXIT_WHEN_DONE=1`. Under Xvfb, force X11 so that no window opens on a Wayland desktop:

```sh
env -u WAYLAND_DISPLAY GDK_BACKEND=x11 GALATSA_RESULTS_DIR=/tmp/results \
  GALATSA_PLATFORM_LABEL=linux-xvfb GALATSA_AUTORUN=all GALATSA_EXIT_WHEN_DONE=1 \
  xvfb-run -a -s "-screen 0 1280x800x24" src-tauri/target/release/galatsa-bench-shell
```

`results/linux-xvfb/` holds one such run from the development machine (software rendering in Xvfb, no GPU). It shows that the app works end to end; its numbers say nothing about the engines.

## Comparing results across machines

Compare engines within one machine first, and machines only by verdicts:

- On one machine, all three engines ran in the same web view, display and power state, so their numbers compare directly. Use the two timing runs; the capture run is never valid. If the two timing runs disagree on a target, the engine sits near that target's limit there.
- Across machines, compare which targets each engine passes, not raw milliseconds. The frame targets depend on the web engine: WebView2 on Windows is Chromium (the 16.7 ms target applies), WebKitGTK on Linux and WKWebView on macOS are WebKit (the 33 ms target applies).
- Check `verdictInputs.valid` and `problems`, the measured refresh rate, and `targets.*.judgedBy` before trusting a run. At 75, 100 or 144 Hz the frame targets are judged by main-thread work only. WKWebView may cap animation frames at 60 Hz even on 120 Hz displays, and at 30 Hz in Low Power Mode (the run is then marked not valid).
- Memory figures differ by method (PSS on Linux, physical footprint on macOS, summed working sets on Windows, which count shared pages more than once and so read high). Compare engines on one machine; across machines, only whether they stay under 1.5 GB, and only where `hostMemory.withoutTotal` is 0.
- Text-sharpness latency of the DOM engine is a lower bound everywhere (the browser re-rasterises text later than the page can see); look at the captures of the canvas engines and at the engine prototypes' own screenshots.
- Load time (`loadMs`) and image generation time depend on the CPU and on the web engine's JPEG encoder and decoders, and are not part of the targets.

## Builds on GitHub

`.github/workflows/bench-shell.yml` runs `pnpm check` and builds the app unsigned for Linux (deb, AppImage and the plain program file), Windows (NSIS installer) and macOS (universal dmg, ad-hoc signed) on every push to a `bench-shell/**` branch and on manual start. The files are kept as workflow artifacts for 30 days; nothing is released. The runners are virtual machines without a real graphics card: their numbers must not be used to choose an engine.

## Dependencies

Rust crates (versions in `src-tauri/Cargo.lock`): `tauri` 2.12.5 and `tauri-build` 2.7.4 (Apache-2.0 OR MIT), `sysinfo` 0.40.3 (MIT), `serde`, `serde_json` and `libc` (MIT OR Apache-2.0); npm: `@tauri-apps/api` and `@tauri-apps/cli` 2.12.4 (Apache-2.0 OR MIT). Licenses from crates.io and the npm registry, checked 2026-11-26. Every crate version in `Cargo.lock` was published at least 14 days before 2026-11-26 (checked against the `pubtime` field of the crates.io index; newer patch releases were pinned back with `cargo update --precise`). The repository's checks do not cover Rust crates yet: neither their licenses nor their age is checked automatically, so a `cargo update` must be checked by hand.

No Tauri logo is used (its license is not free); the icon in `src-tauri/icons/` is a plain generated image.

## Not done

- No COOP/COEP headers: `measureUserAgentSpecificMemory()` is unavailable in the app (informational only in the bench).
- No host screenshots, so the DOM engine's capture run has no images.
- No Content Security Policy (`csp: null`); the app only loads its own pages.
- The engines run in a fixed order (Konva, canvas, DOM) in one app session. Memory the web process keeps after a page load may raise the next engine's peak; run single engines in a freshly started app to rule that out.
