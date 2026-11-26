// SPDX-License-Identifier: GPL-3.0-or-later

//! Facts about the machine, saved next to every result so that results from
//! different machines can be told apart and compared. Everything is best effort:
//! a field that cannot be read is None, never guessed.

use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    /// "linux", "macos" or "windows" (Rust's target OS).
    pub os: &'static str,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub os_long_version: Option<String>,
    pub kernel_version: Option<String>,
    pub arch: &'static str,
    pub cpu: Option<String>,
    pub logical_cpus: usize,
    pub physical_cores: Option<usize>,
    pub total_memory_bytes: Option<u64>,
    /// Graphics adapters, as the operating system names them.
    pub gpus: Vec<String>,
    pub power: Power,
    pub webview: WebView,
    pub tauri_version: &'static str,
    pub app_version: &'static str,
    /// Session-type hints on Linux (Wayland or X11, desktop), None elsewhere.
    pub display_server: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Power {
    /// True on mains power, false on battery, None if unknown (or no battery).
    pub on_mains: Option<bool>,
    pub battery_percent: Option<f64>,
    /// macOS Low Power Mode, Linux platform profile "low-power"; None if unknown.
    pub low_power_mode: Option<bool>,
    /// The raw text the facts were read from, for checking by hand.
    pub details: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebView {
    pub engine: &'static str,
    pub version: Option<String>,
}

#[cfg(target_os = "linux")]
const WEBVIEW_ENGINE: &str = "WebKitGTK";
#[cfg(target_os = "macos")]
const WEBVIEW_ENGINE: &str = "WKWebView (WebKit)";
#[cfg(target_os = "windows")]
const WEBVIEW_ENGINE: &str = "WebView2 (Chromium)";
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
const WEBVIEW_ENGINE: &str = "unknown";

pub fn collect() -> HostInfo {
    use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
    let system = System::new_with_specifics(
        RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing())
            .with_memory(MemoryRefreshKind::nothing().with_ram()),
    )
    .ok();
    let cpu = system
        .as_ref()
        .and_then(|s| s.cpus().first().map(|c| c.brand().trim().to_string()))
        .filter(|s| !s.is_empty());
    HostInfo {
        os: std::env::consts::OS,
        os_name: System::name().ok(),
        os_version: System::os_version().ok(),
        os_long_version: System::long_os_version().ok(),
        kernel_version: System::kernel_version().ok(),
        arch: std::env::consts::ARCH,
        cpu,
        logical_cpus: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(0),
        physical_cores: System::physical_core_count().ok(),
        total_memory_bytes: system.as_ref().map(|s| s.total_memory()),
        gpus: gpus(),
        power: power(),
        webview: WebView {
            engine: WEBVIEW_ENGINE,
            version: tauri::webview_version().ok(),
        },
        tauri_version: tauri::VERSION,
        app_version: env!("CARGO_PKG_VERSION"),
        display_server: display_server(),
    }
}

/// Runs a command without a console window and returns its standard output.
fn output(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console window flashes up.
        command.creation_flags(0x0800_0000);
    }
    let out = command.output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ---------------------------------------------------------------------------
// Graphics adapters

/// On Linux the adapters are read from sysfs (and named with lspci where it is
/// installed). sysinfo's Linux GPU code loads NVML and Vulkan into the process,
/// which would add their memory to every measurement, so it is not used there.
#[cfg(target_os = "linux")]
fn gpus() -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return out;
    };
    let mut cards: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("card") && !n.contains('-'))
        })
        .collect();
    cards.sort();
    for card in cards {
        let Ok(uevent) = std::fs::read_to_string(card.join("device/uevent")) else {
            continue;
        };
        let field = |key: &str| {
            uevent
                .lines()
                .find_map(|l| l.strip_prefix(key))
                .map(str::to_string)
        };
        let driver = field("DRIVER=").unwrap_or_else(|| "unknown driver".into());
        let pci_id = field("PCI_ID=");
        let slot = field("PCI_SLOT_NAME=");
        let name = slot
            .as_deref()
            .and_then(|s| output("lspci", &["-s", s]))
            .filter(|line| !line.is_empty());
        out.push(match (name, pci_id) {
            (Some(n), Some(id)) => format!("{n} [{id}] (driver {driver})"),
            (None, Some(id)) => format!("PCI {id} (driver {driver})"),
            (Some(n), None) => format!("{n} (driver {driver})"),
            (None, None) => format!("driver {driver}"),
        });
    }
    out
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn gpus() -> Vec<String> {
    sysinfo::Gpus::new_with_refreshed_list()
        .map(|list| {
            list.iter()
                .map(|g| {
                    let model = g.model().unwrap_or("unknown model");
                    match g.vendor() {
                        Some(v) if !model.contains(v) => format!("{v} {model}"),
                        _ => model.to_string(),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn gpus() -> Vec<String> {
    Vec::new()
}

// ---------------------------------------------------------------------------
// Power

#[cfg(target_os = "linux")]
fn power() -> Power {
    let mut on_mains = None;
    let mut battery_percent = None;
    let mut details = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/sys/class/power_supply") {
        for entry in entries.flatten() {
            let path = entry.path();
            let read = |f: &str| {
                std::fs::read_to_string(path.join(f))
                    .ok()
                    .map(|s| s.trim().to_string())
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            match read("type").as_deref() {
                Some("Mains") => {
                    let online = read("online");
                    details.push(format!(
                        "{name}: mains online={}",
                        online.as_deref().unwrap_or("?")
                    ));
                    if online.as_deref() == Some("1") {
                        on_mains = Some(true);
                    } else if on_mains.is_none() {
                        on_mains = Some(false);
                    }
                }
                // Batteries of mice and other devices have the scope "Device".
                Some("Battery") if read("scope").as_deref() != Some("Device") => {
                    let capacity = read("capacity");
                    let status = read("status");
                    details.push(format!(
                        "{name}: battery {}% {}",
                        capacity.as_deref().unwrap_or("?"),
                        status.as_deref().unwrap_or("?")
                    ));
                    battery_percent = battery_percent.or(capacity.and_then(|c| c.parse().ok()));
                }
                _ => {}
            }
        }
    }
    let profile = std::fs::read_to_string("/sys/firmware/acpi/platform_profile")
        .ok()
        .map(|s| s.trim().to_string());
    if let Some(p) = &profile {
        details.push(format!("platform_profile: {p}"));
    }
    Power {
        on_mains,
        battery_percent,
        low_power_mode: profile.map(|p| p == "low-power"),
        details: (!details.is_empty()).then(|| details.join("; ")),
    }
}

#[cfg(target_os = "macos")]
fn power() -> Power {
    let batt = output("pmset", &["-g", "batt"]);
    let settings = output("pmset", &["-g"]);
    let on_mains = batt.as_deref().and_then(|b| {
        if b.contains("'AC Power'") {
            Some(true)
        } else if b.contains("'Battery Power'") {
            Some(false)
        } else {
            None
        }
    });
    let battery_percent = batt.as_deref().and_then(|b| {
        let end = b.find('%')?;
        let start = b[..end]
            .rfind(|c: char| !c.is_ascii_digit())
            .map_or(0, |i| i + 1);
        b[start..end].parse().ok()
    });
    let low_power_mode = settings.as_deref().and_then(|s| {
        s.lines()
            .find(|l| l.trim_start().starts_with("lowpowermode"))
            .and_then(|l| l.split_whitespace().nth(1))
            .map(|v| v == "1")
    });
    Power {
        on_mains,
        battery_percent,
        low_power_mode,
        details: batt,
    }
}

#[cfg(target_os = "windows")]
fn power() -> Power {
    // BatteryStatus 2 means "on AC power" in Win32_Battery; no battery, no answer.
    let text = output(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json -Compress",
        ],
    );
    let json: Option<serde_json::Value> = text
        .as_deref()
        .filter(|t| !t.is_empty())
        .and_then(|t| serde_json::from_str(t).ok());
    let on_mains = json
        .as_ref()
        .and_then(|j| j.get("BatteryStatus"))
        .and_then(|v| v.as_i64())
        .map(|s| s == 2);
    let battery_percent = json
        .as_ref()
        .and_then(|j| j.get("EstimatedChargeRemaining"))
        .and_then(|v| v.as_f64());
    Power {
        on_mains,
        battery_percent,
        low_power_mode: None,
        details: text,
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn power() -> Power {
    Power {
        on_mains: None,
        battery_percent: None,
        low_power_mode: None,
        details: None,
    }
}

fn display_server() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let parts: Vec<String> = [
        ("XDG_SESSION_TYPE", var("XDG_SESSION_TYPE")),
        ("XDG_CURRENT_DESKTOP", var("XDG_CURRENT_DESKTOP")),
        ("WAYLAND_DISPLAY", var("WAYLAND_DISPLAY")),
        ("DISPLAY", var("DISPLAY")),
        ("GDK_BACKEND", var("GDK_BACKEND")),
    ]
    .into_iter()
    .filter_map(|(k, v)| v.map(|v| format!("{k}={v}")))
    .collect();
    (!parts.is_empty()).then(|| parts.join(" "))
}
