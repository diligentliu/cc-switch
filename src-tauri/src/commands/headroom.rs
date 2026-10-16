use crate::services::headroom::{HeadroomService, HeadroomStatus};
use crate::store::AppState;
use std::time::Duration;

/// Headroom preloads tokenizers and models on boot; it needs roughly 6-8s before /health answers.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// Headroom forwards upstream to CC Switch's own listener — the opposite
/// direction from `proxy_front_port`, which is where clients reach Headroom.
async fn cc_switch_origin(db: &crate::database::Database) -> Result<String, String> {
    let config = db
        .get_global_proxy_config()
        .await
        .map_err(|e| format!("failed to read proxy config: {e}"))?;
    Ok(crate::services::proxy::proxy_origin(
        &config.listen_address,
        config.listen_port,
    ))
}

#[tauri::command]
pub async fn headroom_status(state: tauri::State<'_, AppState>) -> Result<HeadroomStatus, String> {
    Ok(state.headroom_service.status().await)
}

#[tauri::command]
pub async fn headroom_is_installed() -> Result<bool, String> {
    Ok(HeadroomService::is_installed())
}

#[tauri::command]
pub async fn headroom_install() -> Result<String, String> {
    HeadroomService::install().await
}

#[tauri::command]
pub async fn headroom_update() -> Result<String, String> {
    HeadroomService::update().await
}

#[tauri::command]
pub async fn headroom_uninstall(
    state: tauri::State<'_, AppState>,
    port: u16,
) -> Result<String, String> {
    state.headroom_service.stop_on_port(port).await?;
    HeadroomService::uninstall().await
}

#[tauri::command]
pub async fn headroom_start(state: tauri::State<'_, AppState>, port: u16) -> Result<u32, String> {
    let upstream = cc_switch_origin(&state.db).await?;
    let pid = state.headroom_service.start(port, &upstream).await?;
    HeadroomService::wait_ready(port, READY_TIMEOUT).await?;
    Ok(pid)
}

#[tauri::command]
pub async fn headroom_stop(state: tauri::State<'_, AppState>, port: u16) -> Result<(), String> {
    state.headroom_service.stop_on_port(port).await
}

#[tauri::command]
pub async fn headroom_restart(state: tauri::State<'_, AppState>, port: u16) -> Result<u32, String> {
    let upstream = cc_switch_origin(&state.db).await?;
    let pid = state.headroom_service.restart(port, &upstream).await?;
    HeadroomService::wait_ready(port, READY_TIMEOUT).await?;
    Ok(pid)
}

#[tauri::command]
pub async fn headroom_settings_schema(port: u16) -> Result<serde_json::Value, String> {
    HeadroomService::fetch_schema(port).await
}

#[tauri::command]
pub async fn headroom_save_settings(
    port: u16,
    values: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (needs_restart, changed_keys) = HeadroomService::save_settings(port, values).await?;
    Ok(serde_json::json!({
        "needsRestart": needs_restart,
        "changedKeys": changed_keys,
    }))
}
