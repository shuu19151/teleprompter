# Android on a USB device

Build from the `teleprompter` directory. Install the Android SDK platform and build tools required by the generated Gradle project, the NDK, Android SDK Platform Tools, and Android Studio's JDK. Set `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME` to their respective installation directories.

```powershell
rustup target add aarch64-linux-android
npm ci
./scripts/build-android.ps1
```

On the phone, enable developer options and USB debugging. Connect with a data cable, unlock the phone and accept the RSA fingerprint for this computer. On Windows run:

```powershell
$adb = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
& $adb devices -l
```

Choose the serial listed as `device`. An empty list means ADB cannot see the device. For `unauthorized`, check the RSA prompt on the phone. Verify the actual hardware and install the generated ARM64 debug APK:

```powershell
$serial = Read-Host 'ADB serial'
& $adb -s $serial shell getprop ro.product.model
& $adb -s $serial shell getprop ro.build.version.sdk
& $adb -s $serial shell getprop ro.product.cpu.abi
$apk = Get-ChildItem src-tauri/gen/android/app/build/outputs/apk -Recurse -Filter '*debug.apk' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
& $adb -s $serial install -r $apk.FullName
& $adb -s $serial shell monkey -p com.shuu19151.teleprompter 1
```

For live development use `npm run tauri -- android dev`. For offline acceptance use the APK from `android build`: stop Vite, unplug USB and cold-launch the app. Verify Files → Open with, Share → Teleprompter (both cold and warm), persistent library access, external changes, duplicate imports, reading position after rotation, microphone permission denial/retry, record/pause/resume, playback, recovery and export. Record OS, API, ABI and observed results for the actual handset.

## Phase two: video teleprompter

Open a native CameraX activity from the current text. Pass its stable ID, displayed title, script and reader settings. Bind Preview and VideoCapture to the same lifecycle and camera selector. Render the script as a separate touchable view above PreviewView. Its position, opacity, font size and scroll speed are adjustable. The encoder receives camera frames only.

Before starting capture, request CAMERA and RECORD_AUDIO and finalize any active audio Take with confirmation. Let the reader choose front or rear lens before starting. Prefer 1080p, fall back to supported 720p, and disable recording with a clear explanation if neither is available. Lock recording orientation at start. Start scrolling on recording start; pausing the script must leave the recorder running.

Write MP4 through MediaStore.Video; publish its URI against the text ID only after CameraX reports successful finalization. Stop and finalize on leaving the activity, handle low storage and revoked permissions, and avoid publishing unreadable media. Provide playback and Android sharing from the text's video list.

Acceptance on the Xiaomi: record with both lenses in landscape and portrait, pause the script mid-sentence, leave during capture, play the result in Gallery, verify audio sync and orientation and check that no script text is burned into the video.
