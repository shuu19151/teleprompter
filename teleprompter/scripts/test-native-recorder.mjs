import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const calls = []
const listeners = new Map()
const unsubscribed = []
let failListenAt = ''
let failStop = false

mock.module('@tauri-apps/api/core', {
  namedExports: {
    invoke(command, args) {
      calls.push({ command, args })
      if (command === 'recorder_start' && args?.textKey === 'busy') {
        return Promise.reject(
          '{"code":"already_recording","message":"a recording is already in progress"}',
        )
      }
      if (command === 'recorder_start') return Promise.resolve({ sessionId: 'sess-1', sampleRate: 48000 })
      if (command === 'recorder_stop' && failStop) {
        return Promise.reject('{"code":"write","message":"could not write the recording: disk"}')
      }
      if (command === 'recorder_stop') {
        return Promise.resolve({
          path: 'take.wav',
          durationMs: 1000,
          bytes: 96044,
          droppedSamples: 0,
          peaks: [0.25, 0.5],
        })
      }
      if (command === 'recorder_status') {
        return Promise.resolve({ state: 'idle', durationMs: 0, sessionId: null })
      }
      if (command === 'recorder_cancel') return Promise.resolve(null)
      if (command === 'recorder_list_devices') {
        return Promise.resolve([
          { id: 'wasapi:{laptop}', name: 'Laptop mic', isDefault: true, channels: 2, sampleRates: [48000] },
        ])
      }
      return Promise.reject(`unexpected command ${command}`)
    },
  },
})

mock.module('@tauri-apps/api/event', {
  namedExports: {
    listen(name, handler) {
      if (name === failListenAt) return Promise.reject(new Error('listen failed'))
      const handlers = listeners.get(name) || []
      handlers.push(handler)
      listeners.set(name, handlers)
      return Promise.resolve(() => {
        unsubscribed.push(name)
        const current = listeners.get(name) || []
        listeners.set(
          name,
          current.filter((item) => item !== handler),
        )
      })
    },
  },
})

const { createNativeRecorder, listDevices } = await import('../src/recording/native-recorder.js')

const EVENT_NAMES = ['recorder://meter', 'recorder://peaks', 'recorder://state', 'recorder://error']

function emit(name, payload) {
  for (const handler of listeners.get(name) || []) handler({ payload })
}

function reset() {
  calls.length = 0
  unsubscribed.length = 0
  listeners.clear()
  failListenAt = ''
  failStop = false
}

test('native recorder commands invoke the rust recorder and forward events', async () => {
  reset()
  const seen = []
  const recorder = createNativeRecorder({
    onMeter(payload) {
      seen.push(['meter', payload])
    },
    onPeaks(payload) {
      seen.push(['peaks', payload])
    },
    onState(payload) {
      seen.push(['state', payload])
    },
    onError(payload) {
      seen.push(['error', payload])
    },
  })

  assert.deepEqual(await recorder.start('E01'), { sessionId: 'sess-1', sampleRate: 48000 })
  emit('recorder://state', { state: 'recording', durationMs: 0 })
  emit('recorder://meter', { rms: 0.1, peak: 0.4, clipped: false })
  emit('recorder://peaks', { startIndex: 0, values: [0.4, 0.5] })
  emit('recorder://error', { code: 'capture', message: 'the microphone stream failed' })
  assert.deepEqual(seen, [
    ['state', { state: 'recording', durationMs: 0 }],
    ['meter', { rms: 0.1, peak: 0.4, clipped: false }],
    ['peaks', { startIndex: 0, values: [0.4, 0.5] }],
    ['error', { code: 'capture', message: 'the microphone stream failed' }],
  ])

  assert.deepEqual(await recorder.stop(), {
    path: 'take.wav',
    durationMs: 1000,
    bytes: 96044,
    droppedSamples: 0,
    peaks: [0.25, 0.5],
  })
  emit('recorder://meter', { rms: 1, peak: 1, clipped: true })
  assert.equal(seen.length, 4)
  assert.deepEqual(unsubscribed, EVENT_NAMES)
  assert.deepEqual(await recorder.status(), { state: 'idle', durationMs: 0, sessionId: null })
  assert.deepEqual(calls.map((call) => call.command), ['recorder_start', 'recorder_stop', 'recorder_status'])
})

test('stop and cancel unsubscribe even when the command rejects', async () => {
  reset()
  const recorder = createNativeRecorder()
  await recorder.start('E01')
  failStop = true
  unsubscribed.length = 0
  await assert.rejects(recorder.stop(), (error) => {
    assert.equal(String(error), '{"code":"write","message":"could not write the recording: disk"}')
    return true
  })
  assert.deepEqual(unsubscribed, EVENT_NAMES)

  unsubscribed.length = 0
  await recorder.start('E01')
  unsubscribed.length = 0
  assert.equal(await recorder.cancel(), null)
  assert.deepEqual(unsubscribed, EVENT_NAMES)
  assert.equal(listeners.get('recorder://meter')?.length || 0, 0)
})

test('start sends the selected device and channel, and list reads the host', async () => {
  reset()
  const recorder = createNativeRecorder()
  await recorder.start('E01', { deviceId: 'wasapi:{usb}', channel: 1 })
  assert.deepEqual(calls[0], {
    command: 'recorder_start',
    args: { textKey: 'E01', deviceId: 'wasapi:{usb}', channel: 1 },
  })
  calls.length = 0
  await recorder.start('E01', { deviceId: '', channel: 0 })
  assert.deepEqual(calls[0], { command: 'recorder_start', args: { textKey: 'E01', channel: 0 } })
  calls.length = 0
  assert.deepEqual(await listDevices(), [
    { id: 'wasapi:{laptop}', name: 'Laptop mic', isDefault: true, channels: 2, sampleRates: [48000] },
  ])
  assert.equal(calls[0].command, 'recorder_list_devices')
})

test('a rejected start keeps the typed error string and unsubscribes', async () => {
  reset()
  const recorder = createNativeRecorder()
  await assert.rejects(recorder.start('busy'), (error) => {
    assert.equal(
      String(error),
      '{"code":"already_recording","message":"a recording is already in progress"}',
    )
    return true
  })
  assert.deepEqual(unsubscribed, EVENT_NAMES)
  assert.equal(listeners.get('recorder://meter')?.length || 0, 0)
})

test('a failed listen drops the subscriptions it already opened', async () => {
  reset()
  failListenAt = 'recorder://peaks'
  const recorder = createNativeRecorder()
  await assert.rejects(recorder.start('E01'), /listen failed/)
  assert.deepEqual(unsubscribed, ['recorder://meter'])
  assert.equal(listeners.get('recorder://meter')?.length || 0, 0)
  assert.equal(calls.length, 0)
})
