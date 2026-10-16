use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

const TOOL_NAME: &str = "headroom-ai";
const BINARY_NAME: &str = "headroom";
const EXTRAS: &str = "all";
/// Pinned to match the upstream install instructions; some optional deps misbehave below 3.13.
const PYTHON_VERSION: &str = "3.13";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeadroomStatus {
    pub running: bool,
    pub port: u16,
    pub version: Option<String>,
    pub pid: Option<u32>,
}

/// Some tools report failures on stdout and leave stderr empty, which surfaced
/// as a blank error in the UI.
fn failure_message(command: &str, out: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let detail = stderr.trim();
    let detail = if detail.is_empty() {
        stdout.trim()
    } else {
        detail
    };
    if detail.is_empty() {
        format!("{command} failed with status {}", out.status)
    } else {
        format!("{command} failed: {detail}")
    }
}

#[derive(Clone)]
pub struct HeadroomService {
    child: Arc<Mutex<Option<Child>>>,
}

impl HeadroomService {
    pub fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
        }
    }

    /// Apps launched from Finder inherit only the bare system PATH, so `uv` and
    /// `headroom` stay invisible. Ask the login shell for the real one, once.
    fn user_path() -> Option<String> {
        use std::sync::OnceLock;
        static CACHE: OnceLock<Option<String>> = OnceLock::new();
        CACHE
            .get_or_init(|| {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
                let out = std::process::Command::new(shell)
                    .arg("-lic")
                    .arg("printf %s \"$PATH\"")
                    .output()
                    .ok()?;
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                (!path.is_empty()).then_some(path)
            })
            .clone()
    }

    fn resolve_in_path(name: &str) -> Option<PathBuf> {
        let path = Self::user_path()?;
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    }

    fn resolve_binary() -> Option<PathBuf> {
        let uv = Self::uv_binary()?;
        let out = std::process::Command::new(uv)
            .arg("tool")
            .arg("dir")
            .output()
            .ok()?;
        if out.status.success() {
            let root = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
            let bin = root.join(TOOL_NAME).join("bin").join(BINARY_NAME);
            if bin.is_file() {
                return Some(bin);
            }
        }
        Self::resolve_in_path(BINARY_NAME)
    }

    fn uv_binary() -> Option<PathBuf> {
        Self::resolve_in_path("uv")
    }

    /// Whether a Headroom we started is actually accepting connections on `port`.
    /// Clients must never be pointed at a port nothing is serving.
    pub fn is_listening(port: u16) -> bool {
        (port > 0) && Self::listener_pid(port).is_some_and(Self::is_our_headroom)
    }

    pub fn is_installed() -> bool {
        Self::resolve_binary().is_some()
    }

    pub fn installed_version() -> Option<String> {
        let bin = Self::resolve_binary()?;
        let out = std::process::Command::new(bin)
            .arg("--version")
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        text.split_whitespace().last().map(|s| s.to_string())
    }

    /// The child handle is lost whenever the app restarts, leaving our Headroom
    /// orphaned under launchd. Fall back to finding the listener by port so we
    /// can still stop and restart what we started.
    fn listener_pid(port: u16) -> Option<u32> {
        let out = std::process::Command::new("lsof")
            .arg("-nP")
            .arg(format!("-iTCP:{port}"))
            .arg("-sTCP:LISTEN")
            .arg("-t")
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .and_then(|line| line.trim().parse().ok())
    }

    fn is_our_headroom(pid: u32) -> bool {
        let out = std::process::Command::new("ps")
            .arg("-p")
            .arg(pid.to_string())
            .arg("-o")
            .arg("args=")
            .output()
            .ok();
        let Some(out) = out else { return false };
        let args = String::from_utf8_lossy(&out.stdout);
        args.contains("headroom") && args.contains("proxy")
    }

    pub async fn status(&self) -> HeadroomStatus {
        let port = crate::settings::get_proxy_front_port().unwrap_or(0);
        let live = (port > 0)
            .then(|| Self::listener_pid(port))
            .flatten()
            .filter(|pid| Self::is_our_headroom(*pid));

        let pid = match live {
            Some(pid) => Some(pid),
            None => {
                let mut guard = self.child.lock().await;
                if let Some(child) = guard.as_mut() {
                    child.id()
                } else {
                    None
                }
            }
        };

        HeadroomStatus {
            running: pid.is_some(),
            port,
            version: Self::installed_version(),
            pid,
        }
    }

    pub async fn start(&self, port: u16, upstream: &str) -> Result<u32, String> {
        if let Some(pid) = Self::listener_pid(port).filter(|pid| Self::is_our_headroom(*pid)) {
            return Ok(pid);
        }

        let mut guard = self.child.lock().await;

        if let Some(child) = guard.as_mut() {
            if let Some(pid) = child.id() {
                return Ok(pid);
            }
        }

        let bin = Self::resolve_binary().ok_or_else(|| {
            "headroom not found; install it from the Headroom section first".to_string()
        })?;

        let child = Command::new(bin)
            .arg("proxy")
            .arg("--port")
            .arg(port.to_string())
            .arg("--anthropic-api-url")
            .arg(upstream)
            .arg("--openai-api-url")
            .arg(upstream)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to start headroom: {e}"))?;

        let pid = child
            .id()
            .ok_or_else(|| "headroom exited immediately".to_string())?;
        *guard = Some(child);
        Ok(pid)
    }

    pub async fn wait_ready(port: u16, timeout: Duration) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + timeout;
        let url = format!("http://127.0.0.1:{port}/health");
        loop {
            if let Ok(resp) = reqwest::Client::new().get(&url).send().await {
                if resp.status().is_success() {
                    return Ok(());
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!("headroom did not become ready on port {port}"));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            child
                .kill()
                .await
                .map_err(|e| format!("failed to stop headroom: {e}"))?;
            let _ = child.wait().await;
        }
        Ok(())
    }

    /// Stops whatever Headroom is listening on `port`, whether or not this app
    /// process is the one that spawned it.
    pub async fn stop_on_port(&self, port: u16) -> Result<(), String> {
        self.stop().await?;
        if let Some(pid) = Self::listener_pid(port).filter(|pid| Self::is_our_headroom(*pid)) {
            let out = std::process::Command::new("kill")
                .arg(pid.to_string())
                .output()
                .map_err(|e| format!("failed to stop headroom: {e}"))?;
            if !out.status.success() {
                return Err(failure_message("kill", &out));
            }
        }
        Ok(())
    }

    pub async fn restart(&self, port: u16, upstream: &str) -> Result<u32, String> {
        self.stop_on_port(port).await?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        self.start(port, upstream).await
    }

    fn client() -> reqwest::Client {
        reqwest::Client::new()
    }

    pub async fn fetch_schema(port: u16) -> Result<serde_json::Value, String> {
        let url = format!("http://127.0.0.1:{port}/settings/schema");
        Self::client()
            .get(&url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| format!("failed to reach headroom: {e}"))?
            .json()
            .await
            .map_err(|e| format!("invalid schema response: {e}"))
    }

    pub async fn save_settings(
        port: u16,
        values: serde_json::Value,
    ) -> Result<(bool, Vec<String>), String> {
        let url = format!("http://127.0.0.1:{port}/settings");
        let resp = Self::client()
            .post(&url)
            .json(&serde_json::json!({ "values": values }))
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("failed to reach headroom: {e}"))?;

        let status = resp.status();
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("invalid response: {e}"))?;

        if !status.is_success() {
            let message = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("settings rejected")
                .to_string();
            return Err(message);
        }

        let needs_restart = body
            .get("needs_restart")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let changed = body
            .get("changed_keys")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        Ok((needs_restart, changed))
    }

    pub async fn install() -> Result<String, String> {
        let uv = Self::uv_binary().ok_or_else(|| {
            "uv not found; install it with Homebrew first (brew install uv)".to_string()
        })?;

        let out = Command::new(uv)
            .arg("tool")
            .arg("install")
            .arg("--python")
            .arg(PYTHON_VERSION)
            .arg(format!("{TOOL_NAME}[{EXTRAS}]"))
            .output()
            .await
            .map_err(|e| format!("failed to run uv: {e}"))?;

        if !out.status.success() {
            return Err(failure_message("uv tool install", &out));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    pub async fn update() -> Result<String, String> {
        let bin = Self::resolve_binary().ok_or_else(|| "headroom is not installed".to_string())?;

        let out = Command::new(bin)
            .arg("update")
            .output()
            .await
            .map_err(|e| format!("failed to run headroom update: {e}"))?;

        if !out.status.success() {
            return Err(failure_message("headroom update", &out));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    pub async fn uninstall() -> Result<String, String> {
        let uv = Self::uv_binary().ok_or_else(|| "uv not found".to_string())?;

        let out = Command::new(uv)
            .arg("tool")
            .arg("uninstall")
            .arg(TOOL_NAME)
            .output()
            .await
            .map_err(|e| format!("failed to run uv: {e}"))?;

        if !out.status.success() {
            return Err(failure_message("uv tool uninstall", &out));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

impl Default for HeadroomService {
    fn default() -> Self {
        Self::new()
    }
}
