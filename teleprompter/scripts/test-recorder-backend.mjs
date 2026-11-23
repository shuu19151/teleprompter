import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NATIVE_PEAK_STEP_MS,
  NATIVE_RECORDER_KEY,
  createNativeCapture,
  createRecorderBackend,
  hasTauriGlobal,
  nativeStartError,
  parseRecorderError,
  readNativeRecorderEnabled,
  selectRecorderBackend,
} from '../src/recording/recorder-backend.js'

test('native recorder stays off unless Tauri and the startup flag are both set', () => {
  assert.equal(NATIVE_RECORDER_KEY, 'tp.nativeRecorder')
  assert.equal(NATIVE_PEAK_STEP_MS, 20)
  const enabled = { getItem: (key) => (key === NATIVE_RECORDER_KEY ? '1' : null) }
  assert.equal(readNativeRecorderEnabled(enabled), true)
  assert.equal(readNativeRecorderEnabled({ getItem: () => '0' }), false)
  assert.equal(readNativeRecorderEnabled({ getItem: () => null }), false)
  assert.equal(readNativeRecorderEnabled(null), false)
  assert.equal(
    readNativeRecorderEnabled({
      getItem() {
        throw new Error('storage blocked')
      },
    }),
    false,
  )

  assert.equal(selectRecorderBackend({ hasTauri: true, nativeEnabled: true }), 'native')
  assert.equal(selectRecorderBackend({ hasTauri: true, nativeEnabled: false }), 'web')
  assert.equal(selectRecorderBackend({ hasTauri: false, nativeEnabled: true }), 'web')
  assert.equal(selectRecorderBackend({ hasTauri: false, nativeEnabled: false }), 'web')
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
  assert.equal(nativeStartError('nope').name, 'AbortError')
})

test('the native backend feeds the waveform and does not build an m4a blob', async () => {
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
            path: 'C:\\Users\\a\\Documents\\Teleprompter\\.sessions\\sess-1\\take.wav',
            durationMs: 1000,
            bytes: 50,
            droppedSamples: 0,
            peaks: [0.2, 0.4, 0.5],
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
  assert.equal(started.extension, 'wav')
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
  assert.equal(stopped, null)
  assert.equal(backend.phase, 'idle')
  assert.equal(backend.isActive(), false)
  assert.equal(disarmed, 1)
  assert.equal(peaks.length, 2)
  assert.match(logs.join('\n'), /take\.wav/)
  assert.match(logs.join('\n'), /3 peaks/)
  assert.equal(stoppedTake.peaks.length, 3)
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
