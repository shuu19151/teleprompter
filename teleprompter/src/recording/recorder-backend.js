/**
 * Chooses the capture behind the record button.
 * A Tauri window always uses the native recorder. The Vite page, including
 * Playwright, keeps the MediaRecorder capture.
 */
import { createCapture } from '#web-capture'
import { createNativeRecorder } from './native-recorder.js'

/** One bar per 20 ms, the same window the native writer uses. */
export const NATIVE_PEAK_STEP_MS = 20
/** The playhead may sit this far past the last closed bar while the next bin is still open. */
export const MAX_PLAYHEAD_LEAD_MS = 100

/**
 * Recorded time at the end of a peak batch. `endMs` is the writer's clock.
 * Without it, the batch is `startIndex` bars of `stepMs` from the first kept sample.
 */
export function peakBatchEndMs(batch, stepMs = NATIVE_PEAK_STEP_MS) {
  const count = batch?.values?.length || 0
  if (!count || !(stepMs > 0)) return 0
  const explicit = Number(batch.endMs)
  if (Number.isFinite(explicit) && explicit >= 0) return explicit
  const start = Number(batch.startIndex)
  const origin = Number.isFinite(start) && start > 0 ? Math.floor(start) : 0
  return (origin + count) * stepMs
}

/**
 * Native playhead. Time zero is the first sample the writer kept, not the
 * moment start() returned. Wall time since start includes leading silence
 * the writer drops, so it runs ahead of the bars. Between batches the
 * playhead may run at most `MAX_PLAYHEAD_LEAD_MS` past the last closed bar.
 */
export function nativePlayheadMs({ recordedMs = 0, sinceMs = 0, lastBarEndMs = 0, haveRecorded = false } = {}) {
  if (!haveRecorded) return 0
  const recorded = Math.max(0, Number(recordedMs) || 0)
  const since = Math.max(0, Number(sinceMs) || 0)
  const last = Math.max(0, Number(lastBarEndMs) || 0)
  const extrapolated = recorded + since
  const cap = last > 0 ? last + MAX_PLAYHEAD_LEAD_MS : MAX_PLAYHEAD_LEAD_MS
  return Math.min(extrapolated, cap)
}

/** `window.__TAURI__` is present because the shell sets withGlobalTauri. */
export function hasTauriGlobal(win) {
  return !!win && typeof win === 'object' && !!win.__TAURI__
}

export function selectRecorderBackend({ hasTauri }) {
  return hasTauri ? 'native' : 'web'
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
    case 'device_missing':
      wrapped.name = 'NotFoundError'
      break
    case 'invalid_channel':
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
 * Native take. Stop encodes the session to an M4A file in Documents and
 * returns that path. The page does not build a second blob. Pause and resume
 * use the same button states as the web capture. The clock counts kept
 * samples only. It stays at zero until the first sample the writer keeps,
 * then stays within 100 ms of the last peak bar.
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
  getTakeMeta,
  now = () => performance.now(),
  createClient = createNativeRecorder,
} = {}) {
  let phase = 'idle'
  let recordedMs = 0
  let recordedAt = 0
  let haveRecorded = false
  let lastBarEndMs = 0
  let cancelStart = false
  let stopWait = null
  let pendingError = false

  let transport = Promise.resolve()

  const native = createClient({
    onMeter(payload) {
      if (!levelsOpen()) return
      onMeter?.(payload)
    },
    onPeaks(payload) {
      if (!levelsOpen()) return
      noteBarEnd(peakBatchEndMs(payload))
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

  function levelsOpen() {
    // Paused drops meter and peak events so the waveform stays still.
    // Stopping still accepts the last batch the writer flushes with the file.
    return phase === 'starting' || phase === 'recording' || phase === 'stopping'
  }

  function noteBarEnd(endMs) {
    const end = Math.max(0, Number(endMs) || 0)
    if (!(end > lastBarEndMs)) return
    const shown = elapsedMs()
    lastBarEndMs = end
    recordedMs = Math.min(Math.max(end, shown), end + MAX_PLAYHEAD_LEAD_MS)
    recordedAt = now()
    haveRecorded = true
  }

  function noteStatusDuration(ms) {
    const value = Math.max(0, Number(ms) || 0)
    if (value <= 0 && !haveRecorded) return
    haveRecorded = true
    if (value > recordedMs) {
      recordedMs = value
      recordedAt = now()
    }
  }

  function elapsedMs() {
    if (!haveRecorded) return 0
    if (phase !== 'recording') return recordedMs
    return nativePlayheadMs({
      haveRecorded: true,
      recordedMs,
      sinceMs: Math.max(0, now() - recordedAt),
      lastBarEndMs,
    })
  }

  function enqueue(task) {
    transport = transport.then(task, task).then(
      () => {},
      () => {},
    )
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

  async function start(_audio, options = {}) {
    if (phase !== 'idle') return { started: false }
    phase = 'starting'
    cancelStart = false
    pendingError = false
    recordedMs = 0
    recordedAt = 0
    haveRecorded = false
    lastBarEndMs = 0
    armWave?.(NATIVE_PEAK_STEP_MS)
    try {
      const textKey = getTextKey?.() || ''
      const meta = getTakeMeta?.() || {}
      const deviceId = typeof options.deviceId === 'string' ? options.deviceId : ''
      const channel = Number.isInteger(options.channel) ? options.channel : undefined
      const code = typeof meta.code === 'string' ? meta.code : ''
      const title = typeof meta.title === 'string' ? meta.title : ''
      const startOptions = { deviceId, channel }
      if (code) startOptions.code = code
      if (title) startOptions.title = title
      await native.start(textKey, startOptions)
      if (cancelStart || phase !== 'starting') {
        phase = 'idle'
        disarm()
        await native.cancel().catch(() => {})
        return { started: false, cancelled: true }
      }
      phase = 'recording'
      if (pendingError) {
        pendingError = false
        onError?.()
      }
      return { started: true, mimeType: 'audio/mp4', extension: 'm4a' }
    } catch (error) {
      phase = 'idle'
      pendingError = false
      disarm()
      throw nativeStartError(error)
    }
  }

  function pause() {
    if (phase !== 'recording') return false
    recordedMs = elapsedMs()
    recordedAt = now()
    phase = 'paused'
    enqueue(async () => {
      try {
        await native.pause()
      } catch {
        await recover('paused')
      }
    })
    return true
  }

  function resume() {
    if (phase !== 'paused') return false
    recordedAt = now()
    phase = 'recording'
    enqueue(async () => {
      try {
        await native.resume()
      } catch {
        await recover('recording')
      }
    })
    return true
  }

  async function recover(expecting) {
    if (phase !== expecting) return
    let status = null
    try {
      status = await native.status()
    } catch {
      status = null
    }
    if (phase !== expecting) return
    if (!status || typeof status.state !== 'string') {
      restoreOptimistic(expecting)
      return
    }
    applyStatus(status)
  }

  function restoreOptimistic(expecting) {
    if (expecting === 'paused') {
      recordedAt = now()
      phase = 'recording'
      return
    }
    recordedMs = elapsedMs()
    recordedAt = now()
    phase = 'paused'
  }

  function applyStatus(status) {
    if (phase === 'idle' || phase === 'stopping' || phase === 'starting') return
    if (status.state === 'paused' || status.state === 'recording') {
      noteStatusDuration(status.durationMs)
      phase = status.state === 'paused' ? 'paused' : 'recording'
      if (phase === 'recording') recordedAt = now()
      return
    }
    if (status.state === 'idle') {
      phase = 'idle'
      disarm()
    }
  }

  function segmentPaths(stopped) {
    if (Array.isArray(stopped?.paths) && stopped.paths.length) return stopped.paths
    if (stopped?.path) return [stopped.path]
    return []
  }

  function savedTake(stopped) {
    const diskPath = typeof stopped?.takePath === 'string' ? stopped.takePath : ''
    if (!diskPath) return null
    return {
      savedToDisk: true,
      diskPath,
      name: typeof stopped.takeName === 'string' ? stopped.takeName : '',
      durationMs: Number(stopped.durationMs) || 0,
      mimeType: 'audio/mp4',
      extension: 'm4a',
    }
  }

  function logTake(stopped) {
    const saved = savedTake(stopped)
    if (saved) {
      console.info(`native recorder m4a ${saved.diskPath} (${saved.durationMs} ms)`)
      return
    }
    const paths = segmentPaths(stopped)
    if (!paths.length) return
    const peaks = Array.isArray(stopped.peaks) ? stopped.peaks.length : 0
    console.info(`native recorder wav ${paths.join(', ')} (${Number(stopped.durationMs) || 0} ms, ${peaks} peaks)`)
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
    recordedMs = elapsedMs()
    recordedAt = now()
    phase = 'stopping'
    let stopped = null
    try {
      await transport
      stopped = await native.stop()
    } catch {
      stopped = null
    }
    phase = 'idle'
    disarm()
    if (!stopped) {
      onStopped?.({ failed: true })
      return null
    }
    logTake(stopped)
    onStopped?.(savedTake(stopped))
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
