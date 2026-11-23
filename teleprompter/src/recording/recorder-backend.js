/**
 * Chooses the capture behind the record button.
 * Native stays off unless the window is Tauri and the dev flag was set at startup.
 * The flag is read once by the composition root; this module does not watch it.
 */
import { createCapture } from './recording.js'
import { createNativeRecorder } from './native-recorder.js'

export const NATIVE_RECORDER_KEY = 'tp.nativeRecorder'
/** One bar per 20 ms, the same window the native writer uses. */
export const NATIVE_PEAK_STEP_MS = 20

export function readNativeRecorderEnabled(storage) {
  try {
    return storage?.getItem(NATIVE_RECORDER_KEY) === '1'
  } catch {
    return false
  }
}

/** `window.__TAURI__` is present because the shell sets withGlobalTauri. */
export function hasTauriGlobal(win) {
  return !!win && typeof win === 'object' && !!win.__TAURI__
}

export function selectRecorderBackend({ hasTauri, nativeEnabled }) {
  return hasTauri && nativeEnabled ? 'native' : 'web'
}

/**
 * The object the recorder controller already drives: phase, elapsed time,
 * start, pause, resume, and stop. `web` is the MediaRecorder capture.
 */
export function createRecorderBackend(kind, options = {}) {
  if (kind === 'native') return createNativeCapture(options)
  return createCapture({
    onError: options.onError,
    onStopped: options.onStopped,
  })
}

export function parseRecorderError(error) {
  const raw = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : ''
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof parsed.code === 'string') return parsed
  } catch {
    return null
  }
  return null
}

export function nativeStartError(error) {
  const parsed = parseRecorderError(error)
  const wrapped = new Error(parsed?.message || 'Could not start recording.')
  switch (parsed?.code) {
    case 'no_device':
      wrapped.name = 'NotFoundError'
      break
    case 'unsupported_format':
      wrapped.name = 'NotSupportedError'
      break
    case 'capture':
    case 'write':
    case 'session':
      wrapped.name = 'NotReadableError'
      break
    default:
      wrapped.name = 'AbortError'
      break
  }
  return wrapped
}

/**
 * Native take. The stored take list still expects an M4A blob, so stop does
 * not invent one. The WAV is already in Documents/Teleprompter/.sessions,
 * and the returned path is written to the console.
 */
export function createNativeCapture({
  onError,
  onStopped,
  onMeter,
  onPeaks,
  onState,
  armWave,
  disarmWave,
  getTextKey,
  createClient = createNativeRecorder,
} = {}) {
  let phase = 'idle'
  let accumulated = 0
  let segmentStart = 0
  let cancelStart = false
  let stopWait = null
  let pendingError = false

  const native = createClient({
    onMeter(payload) {
      onMeter?.(payload)
    },
    onPeaks(payload) {
      onPeaks?.(payload)
    },
    onState(payload) {
      onState?.(payload)
    },
    onError() {
      if (phase === 'recording' || phase === 'paused') onError?.()
      else pendingError = true
    },
  })

  function elapsedMs() {
    if (phase === 'recording') return accumulated + (performance.now() - segmentStart)
    return accumulated
  }

  function isActive() {
    return phase === 'starting' || phase === 'recording' || phase === 'paused' || phase === 'stopping'
  }

  function disarm() {
    disarmWave?.()
  }

  function cancel() {
    if (phase === 'starting') cancelStart = true
  }

  async function start() {
    if (phase !== 'idle') return { started: false }
    phase = 'starting'
    cancelStart = false
    pendingError = false
    accumulated = 0
    armWave?.(NATIVE_PEAK_STEP_MS)
    try {
      const textKey = getTextKey?.() || ''
      await native.start(textKey)
      if (cancelStart || phase !== 'starting') {
        phase = 'idle'
        disarm()
        await native.cancel().catch(() => {})
        return { started: false, cancelled: true }
      }
      segmentStart = performance.now()
      phase = 'recording'
      if (pendingError) {
        pendingError = false
        onError?.()
      }
      return { started: true, mimeType: 'audio/wav', extension: 'wav' }
    } catch (error) {
      phase = 'idle'
      pendingError = false
      disarm()
      throw nativeStartError(error)
    }
  }

  function pause() {
    return false
  }

  function resume() {
    return false
  }

  function logTake(stopped) {
    if (!stopped?.path) return
    const peaks = Array.isArray(stopped.peaks) ? stopped.peaks.length : 0
    console.info(`native recorder wav ${stopped.path} (${Number(stopped.durationMs) || 0} ms, ${peaks} peaks)`)
  }

  async function finishStop() {
    if (phase === 'idle') {
      onStopped?.(null)
      return null
    }
    if (phase === 'starting') {
      cancelStart = true
      phase = 'idle'
      disarm()
      await native.cancel().catch(() => {})
      onStopped?.(null)
      return null
    }
    accumulated = elapsedMs()
    phase = 'stopping'
    let stopped = null
    try {
      stopped = await native.stop()
    } catch {
      stopped = null
    }
    phase = 'idle'
    disarm()
    logTake(stopped)
    onStopped?.(null)
    return stopped
  }

  function stop() {
    if (stopWait) return stopWait
    const wait = finishStop().finally(() => {
      if (stopWait === wait) stopWait = null
    })
    stopWait = wait
    return wait
  }

  return {
    usesWebCapture: false,
    get phase() {
      return phase
    },
    get stream() {
      return null
    },
    elapsedMs,
    isActive,
    start,
    pause,
    resume,
    stop,
    cancel,
  }
}
