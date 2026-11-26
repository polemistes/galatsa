// SPDX-License-Identifier: GPL-3.0-or-later

// Which license applies where in this repository (decided 2026-11-26,
// plan/logg/F0-01-review-2.md): the sync server in packages/server is
// AGPL-3.0-or-later, everything else is GPL-3.0-or-later. Used by the workspace check
// (the "license" field of each package) and the SPDX header check (each file).

export const PROGRAM_LICENSE = "GPL-3.0-or-later";
export const SERVER_LICENSE = "AGPL-3.0-or-later";

/** Folder of the sync server package, relative to the repository root. */
export const SERVER_PATH = "packages/server";

/** Returns the license for a path relative to the repository root ("/" or "\\" separators). */
export function licenseForPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === SERVER_PATH || normalized.startsWith(`${SERVER_PATH}/`)
    ? SERVER_LICENSE
    : PROGRAM_LICENSE;
}
