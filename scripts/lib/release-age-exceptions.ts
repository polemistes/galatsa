// SPDX-License-Identifier: GPL-3.0-or-later

// Third-party package versions that may be used although they were published less
// than two weeks ago. The release-age check (scripts/check-release-age.ts) fails for
// every other young version, and for every entry in pnpm's minimumReleaseAgeExclude
// setting that is not listed here.
//
// Add an entry only for a real need, such as a security fix that cannot wait, and
// say why in "reason". Name one exact version per entry. To let pnpm install it,
// add the same "name@version" to minimumReleaseAgeExclude in pnpm-workspace.yaml.
// Remove both once the version is two weeks old: the check reminds you, and it
// fails for an entry whose version is no longer in the lockfile.

import type { ReleaseAgeException } from "./release-age.ts";

export const RELEASE_AGE_EXCEPTIONS: readonly ReleaseAgeException[] = [];
