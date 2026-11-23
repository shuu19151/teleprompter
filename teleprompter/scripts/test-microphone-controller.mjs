import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isMissingMicError, listedAudioInputs } from '../src/recording/microphone-controller.js'

test('a missing microphone is the overconstrained and not-found errors', () => {
  assert.equal(isMissingMicError({ name: 'OverconstrainedError' }), true)
  assert.equal(isMissingMicError({ name: 'NotFoundError' }), true)
  assert.equal(isMissingMicError({ name: 'DevicesNotFoundError' }), true)
  assert.equal(isMissingMicError({ name: 'NotAllowedError' }), false)
  assert.equal(isMissingMicError(null), false)
  assert.equal(isMissingMicError({}), false)
})

test('microphone menu stays on Default until a device has a label', () => {
  assert.deepEqual(listedAudioInputs([]), { labeled: false, inputs: [] })
  assert.deepEqual(
    listedAudioInputs([
      { kind: 'audioinput', deviceId: 'mic-a', label: '' },
      { kind: 'videoinput', deviceId: 'cam', label: 'Camera' },
    ]),
    { labeled: false, inputs: [] },
  )
})

test('labeled microphones are deduped and blank names become Microphone', () => {
  const listed = listedAudioInputs([
    { kind: 'audioinput', deviceId: 'mic-a', label: '  Desk mic  ' },
    { kind: 'audioinput', deviceId: 'mic-a', label: 'Desk mic again' },
    { kind: 'audioinput', deviceId: '', label: 'No id' },
    { kind: 'audioinput', deviceId: 'mic-b', label: '' },
    { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
  ])
  assert.equal(listed.labeled, true)
  assert.deepEqual(listed.inputs, [
    { deviceId: 'mic-a', label: 'Desk mic' },
    { deviceId: 'mic-b', label: 'Microphone' },
  ])
})
