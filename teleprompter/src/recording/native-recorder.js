// Invoke wrapper for the native recorder. The recording UI still uses
// MediaRecorder; nothing here is wired into the page.
// A rejected command is a JSON string: {"code","message"}.

import { invoke } from '@tauri-apps/api/core'

export function start(textKey) {
  return invoke('recorder_start', { textKey })
}

export function stop() {
  return invoke('recorder_stop')
}

export function status() {
  return invoke('recorder_status')
}

export function cancel() {
  return invoke('recorder_cancel')
}
