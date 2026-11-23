import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const calls = []

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
      if (command === 'recorder_stop') {
        return Promise.resolve({ path: 'take.wav', durationMs: 1000, bytes: 96044, droppedSamples: 0 })
      }
      if (command === 'recorder_status') {
        return Promise.resolve({ state: 'idle', durationMs: 0, sessionId: null })
      }
      if (command === 'recorder_cancel') return Promise.resolve(null)
      return Promise.reject(`unexpected command ${command}`)
    },
  },
})

const recorder = await import('../src/recording/native-recorder.js')

test('native recorder commands invoke the rust recorder', async () => {
  calls.length = 0
  assert.deepEqual(await recorder.start('E01'), { sessionId: 'sess-1', sampleRate: 48000 })
  assert.deepEqual(await recorder.stop(), {
    path: 'take.wav',
    durationMs: 1000,
    bytes: 96044,
    droppedSamples: 0,
  })
  assert.deepEqual(await recorder.status(), { state: 'idle', durationMs: 0, sessionId: null })
  assert.equal(await recorder.cancel(), null)
  assert.deepEqual(calls, [
    { command: 'recorder_start', args: { textKey: 'E01' } },
    { command: 'recorder_stop', args: undefined },
    { command: 'recorder_status', args: undefined },
    { command: 'recorder_cancel', args: undefined },
  ])
})

test('a rejected start keeps the typed error string', async () => {
  await assert.rejects(recorder.start('busy'), (error) => {
    assert.equal(
      String(error),
      '{"code":"already_recording","message":"a recording is already in progress"}',
    )
    return true
  })
})
