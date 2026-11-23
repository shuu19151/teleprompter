// The Tauri bundle records through the native recorder. This stub keeps
// MediaRecorder out of that build; the Vite page used by Playwright still
// loads web-capture.js.
export function createCapture() {
  throw new Error('The desktop app records natively.')
}
