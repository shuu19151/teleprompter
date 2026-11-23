mod recorder;

#[cfg(windows)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_opener::init())
    .manage(recorder::RecorderState::new())
    .invoke_handler(tauri::generate_handler![
      recorder::recorder_start,
      recorder::recorder_pause,
      recorder::recorder_resume,
      recorder::recorder_stop,
      recorder::recorder_status,
      recorder::recorder_cancel,
      recorder::recorder_list_devices,
    ])
    // The page origin is http://tauri.localhost. Allowing the microphone here
    // answers getUserMedia before WebView2 draws its site permission prompt.
    // Recording still starts only when Rec calls getUserMedia.
    .on_permission_request(|_webview, kind| match kind {
      tauri::webview::PermissionKind::Microphone => tauri::webview::PermissionResponse::Allow,
      _ => tauri::webview::PermissionResponse::Default,
    })
    .setup(|app| {
      recorder::spawn_device_watch(app.handle().clone());
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // A saved Block skips the handler above. Replace that decision for this origin.
      #[cfg(windows)]
      if let Some(window) = app.get_webview_window("main") {
        allow_saved_microphone(&window);
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

#[cfg(windows)]
fn allow_saved_microphone(window: &tauri::WebviewWindow) {
  if let Err(error) = window.with_webview(|webview| {
    if let Err(error) = set_microphone_allow(&webview) {
      log::warn!("Could not store the microphone permission: {error}");
    }
  }) {
    log::warn!("Could not reach the webview to store the microphone permission: {error}");
  }
}

#[cfg(windows)]
fn set_microphone_allow(webview: &tauri::webview::PlatformWebview) -> windows_core::Result<()> {
  use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
  };
  use windows_core::Interface;

  unsafe {
    let core = webview.controller().CoreWebView2()?;
    let core = core.cast::<ICoreWebView2_13>()?;
    let profile = core.Profile()?;
    let profile = profile.cast::<ICoreWebView2Profile4>()?;
    profile.SetPermissionState(
      COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
      windows_core::w!("http://tauri.localhost"),
      COREWEBVIEW2_PERMISSION_STATE_ALLOW,
      None,
    )
  }
}
