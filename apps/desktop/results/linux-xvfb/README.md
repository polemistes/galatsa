# Xvfb test run: not for decisions

These files come from one run of the measurement app (`GALATSA_AUTORUN=all`) on the development machine inside Xvfb, a virtual X display without a graphics card or a real refresh signal. WebKitGTK 2.54.3 drew everything in software, and frames were paced by a timer near 61 Hz instead of a display. The bench happened to accept that rate, so the timing runs say `valid: true`; they are still not valid for decisions. In an earlier trial run the same timer ran at 62.2 Hz and the bench marked every run not valid.

The run shows that the app works end to end: it runs all three engines, samples the memory of the app and its WebKit processes from the host, writes one JSON file per run, the capture images of the canvas engines, `summary.json` and `summary.txt`, and quits. **Its numbers must not be used to choose an engine.** They do show two things worth checking on real machines: in WebKitGTK both canvas engines peaked near 6 GB of process memory (PSS) against 1.4 to 2.2 GB for the DOM engine, and the DOM engine's peak grew from run to run within the same page. Real numbers come from the users' own machines (see `../../MAALING.md`).

The files are formatted with Prettier, so they are larger than what the app writes.
