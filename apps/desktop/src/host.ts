// SPDX-License-Identifier: GPL-3.0-or-later

// The app's own commands (src-tauri/src/lib.rs), typed.

import { invoke } from "@tauri-apps/api/core";

export interface ProcessMemory {
  readonly pid: number;
  readonly name: string;
  readonly bytes: number | null;
  readonly method: string;
}

export interface MemorySample {
  /** Sum over the app's processes, or null if a web view process is missing or unreadable. */
  readonly bytes: number | null;
  readonly processes: readonly ProcessMemory[];
  readonly problem: string | null;
}

export interface HostInfo {
  readonly os: string;
  readonly osName: string | null;
  readonly osVersion: string | null;
  readonly osLongVersion: string | null;
  readonly kernelVersion: string | null;
  readonly arch: string;
  readonly cpu: string | null;
  readonly logicalCpus: number;
  readonly physicalCores: number | null;
  readonly totalMemoryBytes: number | null;
  readonly gpus: readonly string[];
  readonly power: {
    readonly onMains: boolean | null;
    readonly batteryPercent: number | null;
    readonly lowPowerMode: boolean | null;
    readonly details: string | null;
  };
  readonly webview: { readonly engine: string; readonly version: string | null };
  readonly tauriVersion: string;
  readonly appVersion: string;
  readonly displayServer: string | null;
}

export interface Settings {
  /** Label for folder and file names: "linux", "macos", "windows" or a test label. */
  readonly platform: string;
  readonly resultsRoot: string;
  /** "all" or an engine id when the app was started for an automated run. */
  readonly autorun: string | null;
  readonly exitWhenDone: boolean;
}

export interface Session {
  readonly id: string;
  readonly path: string;
}

export const host = {
  memorySource: () => invoke<string>("memory_source"),
  memorySample: () => invoke<MemorySample>("memory_sample"),
  hostInfo: () => invoke<HostInfo>("host_info"),
  settings: () => invoke<Settings>("settings"),
  startSession: (stamp: string) => invoke<Session>("start_session", { stamp }),
  sessionPath: (session: string) => invoke<string>("session_path", { session }),
  saveText: (session: string, name: string, text: string) =>
    invoke<void>("save_text", { session, name, text }),
  saveBinary: (session: string, name: string, bytes: Uint8Array) =>
    invoke<void>("save_binary", bytes, {
      headers: { "galatsa-session": session, "galatsa-name": name },
    }),
  readText: (session: string, name: string) =>
    invoke<string | null>("read_text", { session, name }),
  openFolder: (session: string | null) => invoke<void>("open_folder", { session }),
  exitApp: (code: number) => invoke<void>("exit_app", { code }),
};
