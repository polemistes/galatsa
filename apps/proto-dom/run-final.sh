#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs the benchmark runs that results/README.md reports, one after another (about
# 25 minutes). Run from apps/proto-dom.
set -u
BENCH_VARIANTS=dom,dom-nogreek,dom-wc-text,dom-screen,dom-layer pnpm exec playwright test bench --project=chromium-gpu
BENCH_SUFFIX=-run2 BENCH_VARIANTS=dom pnpm exec playwright test bench --project=chromium-gpu
BENCH_VARIANTS=dom pnpm exec playwright test bench --project=chromium
BENCH_SUFFIX=-run2 BENCH_VARIANTS=dom pnpm exec playwright test bench --project=chromium
BENCH_VARIANTS=dom pnpm exec playwright test bench --project=firefox
