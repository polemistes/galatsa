// SPDX-License-Identifier: GPL-3.0-or-later

// No console window next to the app on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    galatsa_bench_shell_lib::run();
}
