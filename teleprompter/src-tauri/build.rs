fn main() {
  // rustc links with lld, which does not search GCC's private directory.
  // fdk-aac needs libstdc++. `g++ -print-file-name` is the path GCC itself uses.
  if cfg!(target_os = "linux") {
    if let Ok(output) = std::process::Command::new("g++")
      .arg("-print-file-name=libstdc++.so")
      .output()
    {
      let path = String::from_utf8_lossy(&output.stdout);
      let path = path.trim();
      if let Some(dir) = std::path::Path::new(path).parent() {
        if dir != std::path::Path::new("") {
          println!("cargo:rustc-link-search=native={}", dir.display());
        }
      }
    }
  }
  let attributes = tauri_build::Attributes::new().plugin(
    "android-documents",
    tauri_build::InlinedPlugin::new().commands(&[
      "ensureMicrophonePermission",
      "shareTake",
      "pickDirectory",
      "getSavedDirectory",
      "consumePendingImport",
      "listTexts",
      "readText",
      "writeText",
      "deleteText",
      "registerListener",
      "removeListener",
    ]),
  );
  tauri_build::try_build(attributes).expect("build application permissions");
}
