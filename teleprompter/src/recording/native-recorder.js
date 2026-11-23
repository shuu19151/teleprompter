// Invoke and event wrapper for the native recorder.
// Stop, cancel, and a failed start drop the event listeners.
// A rejected command is a JSON string: {"code","message"}.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

const RECORDER_EVENTS = [
  ['recorder://meter', 'onMeter'],
  ['recorder://peaks', 'onPeaks'],
  ['recorder://state', 'onState'],
  ['recorder://error', 'onError'],
]

export function createNativeRecorder(handlers = {}) {
  let unlistens = []

  async function subscribe() {
    if (unlistens.length) return
    const next = []
    try {
      for (const [name, key] of RECORDER_EVENTS) {
        const handler = handlers[key]
        const unlisten = await listen(name, (event) => {
          handler?.(event?.payload)
        })
        next.push(unlisten)
      }
    } catch (error) {
      await drop(next)
      throw error
    }
    unlistens = next
  }

  async function unsubscribe() {
    const current = unlistens
    unlistens = []
    await drop(current)
  }

  return {
    async start(textKey) {
      await subscribe()
      try {
        return await invoke('recorder_start', { textKey })
      } catch (error) {
        await unsubscribe()
        throw error
      }
    },
    async stop() {
      try {
        return await invoke('recorder_stop')
      } finally {
        await unsubscribe()
      }
    },
    status() {
      return invoke('recorder_status')
    },
    async cancel() {
      try {
        return await invoke('recorder_cancel')
      } finally {
        await unsubscribe()
      }
    },
  }
}

function drop(fns) {
  return Promise.all(fns.map((fn) => Promise.resolve().then(() => fn()).catch(() => {})))
}
