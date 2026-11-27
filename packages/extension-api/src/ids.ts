// SPDX-License-Identifier: GPL-3.0-or-later

// Ids, modes, labels and the version of the extension interface. See
// docs/adr/0005-extension-interface.md, section 2.

import { NAMESPACE_PATTERN, type BundleKey, type MessageBundle } from "@galatsa/i18n";

/**
 * An extension id: lowercase words separated by dots, for example
 * "galatsa.text". It is the first part of every element type id the extension
 * defines ("galatsa.text/text"), of every contribution id, and the namespace of
 * its messages, so it uses the characters all three allow.
 */
export type ExtensionId = string;

export const EXTENSION_ID_PATTERN: RegExp = NAMESPACE_PATTERN;

/**
 * The name of a contribution within its extension (an element type, tool,
 * command, importer, exporter, transition or panel): the characters an element
 * type name allows.
 */
export const CONTRIBUTION_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** "<extension id>/<name>", for example "galatsa.text/insert". */
export type ContributionId = string;

export function contributionId(extension: ExtensionId, name: string): ContributionId {
  return `${extension}/${name}`;
}

/** The extension part of a contribution id or element type id. */
export function extensionOf(id: ContributionId): ExtensionId {
  const slash = id.indexOf("/");
  return slash < 0 ? id : id.slice(0, slash);
}

/**
 * User interface text is never stored in a definition, only a message key
 * "namespace:key", looked up with the program's I18n (docs/adr/0003). The
 * namespace is the extension's own (or a prefix of its id, see section 9.2 of
 * the specification), or "common".
 */
export type Label = `${string}:${string}`;

/** A typed label: the key must exist in the bundle. */
export function messageKey<B extends MessageBundle>(bundle: B, key: BundleKey<B>): Label {
  return `${bundle.namespace}:${key}`;
}

/**
 * The two modes of the editor. Quick mode shows the basic functions, advanced
 * mode everything. A contribution is in quick mode only if it says so; every
 * contribution is in advanced mode.
 */
export type Mode = "quick" | "advanced";

/** True if a contribution with this `quick` flag is offered in `mode`. */
export function availableIn(quick: boolean | undefined, mode: Mode): boolean {
  return mode === "advanced" || quick === true;
}

/**
 * A keyboard shortcut: modifiers and one key joined by "+", for example
 * "Mod+Shift+Z" or "Delete". "Mod" is Ctrl on Windows and Linux and Cmd on
 * macOS. The key is a `KeyboardEvent.key` value. Case does not matter for the
 * modifiers or a single letter; normalizeShortcut gives the canonical spelling.
 */
export type Shortcut = string;

const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift", "Meta"] as const;

/**
 * The canonical spelling of a shortcut (modifiers in a fixed order, a letter in
 * lower case), or undefined if it is not one.
 */
export function normalizeShortcut(shortcut: string): Shortcut | undefined {
  const parts = shortcut.split("+");
  // "Mod++" is Mod and the plus key.
  if (shortcut.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const key = parts.pop();
  if (key === undefined || key === "") return undefined;
  const mods = new Set<string>();
  for (const part of parts) {
    const mod = MODIFIERS.find((m) => m.toLowerCase() === part.toLowerCase());
    if (mod === undefined || mods.has(mod)) return undefined;
    mods.add(mod);
  }
  const ordered = MODIFIERS.filter((m) => mods.has(m));
  const name = key.length === 1 ? key.toLowerCase() : key;
  return [...ordered, name].join("+");
}

/**
 * An icon, by name in the program's icon set. Extensions that bring their own
 * icons name them "<extension id>/<name>" and list them in their manifest.
 */
export type IconRef = string;

/** Version of the extension interface (section 9.3 of the specification). */
export interface ApiVersion {
  /** Raised for every incompatible change. */
  readonly major: number;
  /** Raised for every additive change; reset when major rises. */
  readonly minor: number;
}

/** The version of the interface this package implements. */
export const EXTENSION_API_VERSION: ApiVersion = { major: 1, minor: 2 };

/**
 * True if an extension written against `wanted` runs on a host that implements
 * `host`: same major version, and the host has every addition the extension may
 * use.
 */
export function isApiCompatible(wanted: ApiVersion, host: ApiVersion): boolean {
  return wanted.major === host.major && wanted.minor <= host.minor;
}
