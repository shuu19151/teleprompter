import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  formatRecoveryDuration,
  recoverUnfinishedRecordings,
  recoveryMessage,
} from '../src/recording/recorder-recovery.js'

test('the recovery prompt names the text and the recorded length', () => {
  assert.equal(formatRecoveryDuration(0), '00:00')
  assert.equal(formatRecoveryDuration(65_400), '01:05')
  assert.equal(formatRecoveryDuration(-4), '00:00')
  const message = recoveryMessage({
    sessionId: 'sess-1',
    textKey: 'E01',
    durationMs: 125_000,
    startedAt: '2026-11-23T17:04:05.000Z',
  })
  assert.match(message, /E01/)
  assert.match(message, /2026-11-23T17:04:05.000Z/)
  assert.match(message, /02:05/)
  assert.match(message, /Save it as a take, or discard it/)
})

test('startup asks to save or discard each unfinished recording', async () => {
  const calls = []
  const prompts = []
  const sessions = [
    { sessionId: 'sess-save', textKey: 'E01', durationMs: 61_000, startedAt: '2026-11-23T17:04:05.000Z' },
    { sessionId: 'sess-drop', textKey: 'U1', durationMs: 2_000, startedAt: '2026-11-23T17:06:00.000Z' },
    { sessionId: 'sess-later', textKey: 'E02', durationMs: 500, startedAt: '2026-11-23T17:07:00.000Z' },
  ]
  const choices = [true, false, 'later']
  const applied = await recoverUnfinishedRecordings({
    invoke(command, args) {
      calls.push({ command, args })
      if (command === 'recorder_recover') return Promise.resolve(sessions)
      if (command === 'recorder_recover_apply') return Promise.resolve(null)
      return Promise.reject(new Error(`unexpected ${command}`))
    },
    askConfirm(options) {
      prompts.push(options)
      return Promise.resolve(choices[prompts.length - 1])
    },
  })

  assert.equal(prompts.length, 3)
  assert.equal(prompts[0].title, 'Unfinished recording')
  assert.equal(prompts[0].confirmLabel, 'Save')
  assert.equal(prompts[0].cancelLabel, 'Discard')
  assert.equal(prompts[0].confirmIsDanger, false)
  assert.equal(prompts[0].dismiss, 'later')
  assert.match(prompts[0].message, /E01/)
  assert.match(prompts[1].message, /U1/)
  assert.deepEqual(applied, [
    { sessionId: 'sess-save', action: 'save' },
    { sessionId: 'sess-drop', action: 'discard' },
    { sessionId: 'sess-later', action: 'later' },
  ])
  assert.deepEqual(
    calls.map((call) => call.command),
    ['recorder_recover', 'recorder_recover_apply', 'recorder_recover_apply'],
  )
  assert.deepEqual(calls[1].args, { sessionId: 'sess-save', action: 'save' })
  assert.deepEqual(calls[2].args, { sessionId: 'sess-drop', action: 'discard' })
})

test('an empty recover list does not open the dialog', async () => {
  let asked = 0
  const applied = await recoverUnfinishedRecordings({
    invoke(command) {
      assert.equal(command, 'recorder_recover')
      return Promise.resolve([])
    },
    askConfirm() {
      asked += 1
      return Promise.resolve(true)
    },
  })
  assert.deepEqual(applied, [])
  assert.equal(asked, 0)
})
