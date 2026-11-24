import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_PLAYHEAD_LEAD_MS,
  NATIVE_PEAK_STEP_MS,
  createNativeCapture,
  createRecorderBackend,
  hasTauriGlobal,
  nativePlayheadMs,
  nativeStartError,
  parseRecorderError,
  peakBatchEndMs,
  selectRecorderBackend,
} from '../src/recording/recorder-backend.js'

test('native bars stay on the kept-sample clock and within 100 ms of the playhead', () => {
  assert.equal(MAX_PLAYHEAD_LEAD_MS, 100)
  assert.equal(peakBatchEndMs({ startIndex: 0, values: [0.2, 0.4] }), 40)
  assert.equal(peakBatchEndMs({ startIndex: 2, values: [0.5], endMs: 60 }), 60)
  assert.equal(peakBatchEndMs({ values: [] }), 0)
  assert.equal(peakBatchEndMs(null), 0)

  // Wall clock says 5.23s because start() returned 1.93s before the first
  // kept sample. The bars only cover the kept 3.30s. The playhead follows
  // the bars, not that wall clock.
  const lastBarEndMs = 3_300
  const playhead = nativePlayheadMs({
    haveRecorded: true,
    recordedMs: lastBarEndMs,
    sinceMs: 1_930,
    lastBarEndMs,
  })
  assert.equal(playhead, lastBarEndMs + MAX_PLAYHEAD_LEAD_MS)
  assert.ok(playhead - lastBarEndMs <= 100)
  assert.ok(playhead >= lastBarEndMs)

  // No kept sample yet: the clock stays at the onset instead of running
  // through the leading silence.
  assert.equal(nativePlayheadMs({ haveRecorded: false, sinceMs: 5_230, lastBarEndMs: 0 }), 0)
  assert.equal(
    nativePlayheadMs({ haveRecorded: true, recordedMs: 40, sinceMs: 0, lastBarEndMs: 40 }),
    40,
  )
})

test('the desktop window records natively and the Vite page stays on MediaRecorder', () => {
  assert.equal(NATIVE_PEAK_STEP_MS, 20)
  assert.equal(selectRecorderBackend({ hasTauri: true }), 'native')
  assert.equal(selectRecorderBackend({ hasTauri: true, nativeEnabled: false }), 'native')
  assert.equal(selectRecorderBackend({ hasTauri: false, nativeEnabled: true }), 'web')
  assert.equal(selectRecorderBackend({ hasTauri: false }), 'web')
})

test('the Tauri check reads window.__TAURI__', () => {
  assert.equal(hasTauriGlobal({ __TAURI__: {} }), true)
  assert.equal(hasTauriGlobal({ __TAURI_INTERNALS__: {} }), false)
  assert.equal(hasTauriGlobal(undefined), false)
  assert.equal(hasTauriGlobal(null), false)
})

test('the web backend is the capture the controller already uses', () => {
  const backend = createRecorderBackend('web', {})
  assert.equal(backend.phase, 'idle')
  assert.equal(backend.isActive(), false)
  assert.equal(backend.usesWebCapture, undefined)
  assert.equal(backend.pause(), false)
  assert.equal(backend.resume(), false)
  const fallback = createRecorderBackend(undefined, {})
  assert.equal(fallback.phase, 'idle')
  assert.equal(fallback.isActive(), false)
})

test('a native start error keeps the microphone messages the page already shows', () => {
  const raw = '{"code":"no_device","message":"no microphone was found"}'
  assert.equal(parseRecorderError(raw).code, 'no_device')
  assert.equal(parseRecorderError('not json'), null)
  assert.equal(nativeStartError(raw).name, 'NotFoundError')
  assert.equal(nativeStartError('{"code":"unsupported_format","message":"x"}').name, 'NotSupportedError')
  assert.equal(nativeStartError('{"code":"capture","message":"x"}').name, 'NotReadableError')
  assert.equal(nativeStartError('{"code":"device_missing","message":"x"}').name, 'NotFoundError')
  assert.equal(nativeStartError('{"code":"invalid_channel","message":"x"}').name, 'NotSupportedError')
  assert.equal(nativeStartError('nope').name, 'AbortError')
})

test('the native backend feeds the waveform and reports the saved m4a', async () => {
  const peaks = []
  const meters = []
  let armed = null
  let disarmed = 0
  let stopped = 'missing'
  let failed = 0
  const backend = createNativeCapture({
    onStopped(result) {
      stopped = result
    },
    onError() {
      failed += 1
    },
    onPeaks(batch) {
      peaks.push(batch)
    },
    onMeter(meter) {
      meters.push(meter)
    },
    armWave(stepMs) {
      armed = stepMs
    },
    disarmWave() {
      disarmed += 1
    },
    getTextKey() {
      return 'E01'
    },
    createClient(handlers) {
      return {
        async start(textKey) {
          assert.equal(textKey, 'E01')
          handlers.onState({ state: 'recording', durationMs: 0 })
          handlers.onPeaks({ startIndex: 0, values: [0.2, 0.4] })
          handlers.onMeter({ rms: 0.1, peak: 0.4, clipped: false })
          return { sessionId: 'sess-1', sampleRate: 48000 }
        },
        async stop() {
          handlers.onPeaks({ startIndex: 2, values: [0.5] })
          return {
            path: 'C:\\Users\\a\\Documents\\Teleprompter\\.sessions\\sess-1\\seg-000.wav',
            durationMs: 1000,
            bytes: 50,
            droppedSamples: 0,
            peaks: [0.2, 0.4, 0.5],
            takePath: 'C:\\Users\\a\\Documents\\Teleprompter\\E01-note-20261123-1804.m4a',
            takeName: 'E01-note-20261123-1804.m4a',
          }
        },
        async cancel() {},
        status() {
          return Promise.resolve({ state: 'idle', durationMs: 0 })
        },
      }
    },
  })

  assert.equal(backend.usesWebCapture, false)
  assert.equal(backend.stream, null)
  assert.equal(backend.pause(), false)
  assert.equal(backend.resume(), false)
  const started = await backend.start()
  assert.equal(started.started, true)
  assert.equal(started.extension, 'm4a')
  assert.equal(backend.phase, 'recording')
  assert.equal(armed, 20)
  assert.deepEqual(peaks, [{ startIndex: 0, values: [0.2, 0.4] }])
  assert.deepEqual(meters, [{ rms: 0.1, peak: 0.4, clipped: false }])
  assert.equal(backend.isActive(), true)
  assert.equal(failed, 0)

  const logs = []
  const original = console.info
  console.info = (...args) => {
    logs.push(args.join(' '))
  }
  let stoppedTake
  try {
    stoppedTake = await backend.stop()
  } finally {
    console.info = original
  }
  assert.equal(stopped.savedToDisk, true)
  assert.equal(stopped.name, 'E01-note-20261123-1804.m4a')
  assert.equal(stopped.mimeType, 'audio/mp4')
  assert.equal(backend.phase, 'idle')
  assert.equal(backend.isActive(), false)
  assert.equal(disarmed, 1)
  assert.equal(peaks.length, 2)
  assert.match(logs.join('\n'), /E01-note-20261123-1804\.m4a/)
  assert.equal(stoppedTake.peaks.length, 3)
})

test('native start forwards the selected microphone and channel', async () => {
  let seen = null
  const backend = createNativeCapture({
    armWave() {},
    disarmWave() {},
    getTextKey() {
      return 'E01'
    },
    createClient() {
      return {
        async start(textKey, options) {
          seen = { textKey, options }
          return { sessionId: 'sess-1', sampleRate: 48000 }
        },
        async stop() {
          return null
        },
        async cancel() {},
      }
    },
  })
  const started = await backend.start({ deviceId: { exact: 'ignored' } }, { deviceId: 'wasapi:{usb}', channel: 0 })
  assert.equal(started.started, true)
  assert.deepEqual(seen, {
    textKey: 'E01',
    options: { deviceId: 'wasapi:{usb}', channel: 0 },
  })
})

test('a native start failure disarms the waveform and stays idle', async () => {
  let disarmed = 0
  const backend = createNativeCapture({
    disarmWave() {
      disarmed += 1
    },
    armWave() {},
    getTextKey() {
      return 'E01'
    },
    createClient() {
      return {
        async start() {
          throw '{"code":"no_device","message":"no microphone was found"}'
        },
        async stop() {},
        async cancel() {},
      }
    },
  })
  await assert.rejects(backend.start(), (error) => {
    assert.equal(error.name, 'NotFoundError')
    return true
  })
  assert.equal(backend.phase, 'idle')
  assert.equal(backend.isActive(), false)
  assert.equal(disarmed, 1)
})

test('an error before the take is recording does not stop it early', async () => {
  let failed = 0
  let releaseStart
  const backend = createNativeCapture({
    onError() {
      failed += 1
    },
    armWave() {},
    disarmWave() {},
    getTextKey() {
      return ''
    },
    createClient(handlers) {
      return {
        start() {
          handlers.onError({ code: 'capture', message: 'the microphone stream failed' })
          return new Promise((resolve) => {
            releaseStart = () => resolve({ sessionId: 's', sampleRate: 48000 })
          })
        },
        async stop() {
          return null
        },
        async cancel() {},
      }
    },
  })
  const pending = backend.start()
  assert.equal(failed, 0)
  releaseStart()
  await pending
  assert.equal(failed, 1)
  assert.equal(backend.phase, 'recording')
})

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test('native pause and resume freeze the clock and ignore levels while paused', async () => {
  const calls = []
  const levels = []
  let handlers
  let now = 1_000
  const backend = createNativeCapture({
    now: () => now,
    onPeaks(batch) {
      levels.push(['peaks', batch])
    },
    onMeter(meter) {
      levels.push(['meter', meter])
    },
    armWave() {},
    disarmWave() {},
    getTextKey() {
      return 'E01'
    },
    createClient(received) {
      handlers = received
      return {
        async start() {
          return { sessionId: 'sess-1', sampleRate: 48000 }
        },
        pause() {
          calls.push('pause')
          return Promise.resolve({ state: 'paused', durationMs: 400, sessionId: 'sess-1' })
        },
        resume() {
          calls.push('resume')
          return Promise.resolve({ state: 'recording', durationMs: 400, sessionId: 'sess-1' })
        },
        async stop() {
          return {
            path: 'seg-000.wav',
            paths: ['seg-000.wav', 'seg-001.wav'],
            durationMs: 650,
            bytes: 80,
            droppedSamples: 0,
            peaks: [0.2, 0.3],
          }
        },
        async cancel() {},
        status() {
          return Promise.resolve({ state: 'recording', durationMs: 400, sessionId: 'sess-1' })
        },
      }
    },
  })

  assert.equal(backend.pause(), false)
  assert.equal(backend.resume(), false)
  await backend.start()
  assert.equal(backend.phase, 'recording')
  now = 1_400
  assert.equal(backend.elapsedMs(), 0)
  handlers.onPeaks({ startIndex: 0, values: [0.2, 0.4], endMs: 40 })
  handlers.onMeter({ rms: 0.1, peak: 0.2, clipped: false })
  assert.equal(backend.elapsedMs(), 40)
  assert.equal(levels.length, 2)
  now = 1_490
  assert.equal(backend.elapsedMs(), 130)

  assert.equal(backend.pause(), true)
  assert.equal(backend.phase, 'paused')
  assert.equal(backend.pause(), false)
  now = 5_000
  assert.equal(backend.elapsedMs(), 130)
  handlers.onPeaks({ startIndex: 2, values: [0.9] })
  handlers.onMeter({ rms: 0.8, peak: 0.9, clipped: false })
  assert.equal(levels.length, 2)

  assert.equal(backend.resume(), true)
  assert.equal(backend.phase, 'recording')
  assert.equal(backend.resume(), false)
  now = 5_040
  assert.equal(backend.elapsedMs(), 140)
  handlers.onPeaks({ startIndex: 2, values: [0.3], endMs: 60 })
  assert.deepEqual(levels[2], ['peaks', { startIndex: 2, values: [0.3], endMs: 60 }])
  assert.equal(backend.elapsedMs(), 140)
  assert.ok(backend.elapsedMs() - 60 <= MAX_PLAYHEAD_LEAD_MS)
  await tick()
  assert.deepEqual(calls, ['pause', 'resume'])

  const logs = []
  const original = console.info
  console.info = (...args) => {
    logs.push(args.join(' '))
  }
  try {
    await backend.stop()
  } finally {
    console.info = original
  }
  assert.match(logs.join('\n'), /seg-000\.wav, seg-001\.wav/)
  assert.equal(backend.phase, 'idle')
})

test('a failed native pause follows the recorder status', async () => {
  let now = 2_000
  const backend = createNativeCapture({
    now: () => now,
    armWave() {},
    disarmWave() {},
    getTextKey() {
      return 'E01'
    },
    createClient() {
      return {
        async start() {
          return { sessionId: 'sess-1', sampleRate: 48000 }
        },
        pause() {
          return Promise.reject('{"code":"write","message":"could not write the recording: disk"}')
        },
        async resume() {
          return { state: 'recording', durationMs: 10, sessionId: 'sess-1' }
        },
        status() {
          return Promise.resolve({ state: 'recording', durationMs: 80, sessionId: 'sess-1' })
        },
        async stop() {
          return null
        },
        async cancel() {},
      }
    },
  })
  await backend.start()
  now = 2_080
  assert.equal(backend.pause(), true)
  assert.equal(backend.phase, 'paused')
  await tick()
  assert.equal(backend.phase, 'recording')
  now = 2_100
  assert.equal(backend.elapsedMs(), 100)
})
