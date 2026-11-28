$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
Push-Location $appRoot
try {
  $headers = (Resolve-Path 'src-tauri/android-include').Path
  $env:CPLUS_INCLUDE_PATH = $headers
  $log = Join-Path $env:TEMP ('teleprompter-android-' + [Guid]::NewGuid() + '.log')
  $ErrorActionPreference = 'Continue'
  npm run tauri -- android build --target aarch64 --apk --debug 2>&1 | Tee-Object -FilePath $log
  $buildExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($buildExit -eq 0) { exit 0 }
  if (!(Select-String -LiteralPath $log -SimpleMatch 'Creation symbolic link is not allowed')) { exit $buildExit }
  # Tauri compiled and embedded the web assets before trying the denied symlink.
  $android = 'src-tauri/gen/android'
  Copy-Item -LiteralPath 'src-tauri/target/aarch64-linux-android/debug/libapp_lib.so' -Destination "$android/app/src/main/jniLibs/arm64-v8a/libapp_lib.so" -Force
  & "$android/gradlew.bat" -p $android :app:assembleArm64Debug -x :app:rustBuildArm64Debug
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
