import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  barHeight,
  chooseTakes,
  formatTakeDuration,
  formatTakeWhen,
  micControlState,
  panelChromeState,
  playbackClockText,
  playbackNowSec,
  playbackRatio,
  playbackSampleWindow,
  recControlState,
  recordingBusy,
  recordingSampleWindow,
  rulerMark,
  rulerWindow,
  storedTake,
  takeDateIso,
  takeMeta,
  takeTextKey,
  timelineScale,
  waveX,
} from '../src/recording/recorder-math.js'

const essay = { kind: 'essay', code: 'E01', title: 'How I Stay Productive', file: 'E01-how.txt' }
const imported = { kind: 'import', id: 'imp-1', code: 'U1', title: 'Market notes', file: 'imp-1' }

test('take metadata uses the essay code or the import id', () => {
  assert.equal(takeTextKey(null), '')
  assert.equal(takeTextKey(undefined), '')
  assert.equal(takeTextKey(essay), 'E01')
  assert.equal(takeTextKey(imported), 'imp-1')
  assert.equal(takeTextKey({ kind: 'essay', code: '', title: 'Untitled' }), '')
  assert.equal(takeMeta(null), null)
  assert.equal(takeMeta({ kind: 'essay', title: 'No code' }), null)
  assert.equal(takeMeta({ kind: 'import', id: '', code: 'U1', title: 'Gone' }), null)
  assert.deepEqual(takeMeta(essay), { textKey: 'E01', code: 'E01', title: 'How I Stay Productive' })
  assert.deepEqual(takeMeta(imported), { textKey: 'imp-1', code: 'U1', title: 'Market notes' })
  assert.deepEqual(takeMeta({ kind: 'essay', code: 'E02' }), { textKey: 'E02', code: 'E02', title: 'Untitled' })
  assert.deepEqual(takeMeta({ kind: 'import', id: 'imp-9' }), { textKey: 'imp-9', code: 'take', title: 'Untitled' })
})

test('take time formatting covers invalid, zero, negative, and long values', () => {
  const ms = Date.UTC(2026, 10, 23, 16, 5)
  assert.equal(formatTakeWhen(Number.NaN), '')
  assert.equal(formatTakeWhen('nope'), '')
  assert.equal(formatTakeWhen(undefined), '')
  assert.equal(
    formatTakeWhen(ms, 'en-US'),
    new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)),
  )
  assert.equal(formatTakeWhen(-1), formatTakeWhen(-1, undefined))
  assert.notEqual(formatTakeWhen(0), '')
  assert.equal(takeDateIso('nope'), '')
  assert.equal(takeDateIso(Number.NaN), '')
  assert.equal(takeDateIso(0), '1970-01-01T00:00:00.000Z')
  assert.equal(takeDateIso(ms), '2026-11-23T16:05:00.000Z')
  assert.equal(formatTakeDuration(0), '00:00')
  assert.equal(formatTakeDuration(-100), '00:00')
  assert.equal(formatTakeDuration(1500), '00:01')
  assert.equal(formatTakeDuration(59999), '00:59')
  assert.equal(formatTakeDuration(60000), '01:00')
  assert.equal(formatTakeDuration(3600000), '60:00')
  assert.equal(formatTakeDuration(Number.NaN), 'NaN:NaN')
})

test('waveform x follows centerX + (t - now) * pxPerSec', () => {
  assert.equal(waveX(100, 2, 1, 50), 150)
  assert.equal(waveX(100, 0, 4, 25), 0)
  assert.equal(waveX(0, -10, -10, 8), 0)
  assert.equal(waveX(10, 1e6, 0, 2), 10 + 2e6)
  const scale = timelineScale(900)
  assert.equal(scale.centerX, 450)
  assert.equal(scale.pxPerSec, 62.5)
  assert.deepEqual(timelineScale(0), { centerX: 0, pxPerSec: 0 })
  assert.equal(timelineScale(-20).centerX, -10)
})

test('ruler marks and the visible window stay at or after 00:00', () => {
  assert.deepEqual(rulerMark(0, 50), { tMs: 0, x: 0, major: true })
  assert.deepEqual(rulerMark(1, 50), { tMs: 500, x: 25, major: false })
  assert.deepEqual(rulerMark(4, 50), { tMs: 2000, x: 100, major: true })
  assert.equal(rulerMark(-1, 50).major, false)
  assert.equal(rulerWindow(0, 0, 10, 0), null)
  assert.equal(rulerWindow(-5, 0, 10, 0), null)
  assert.equal(rulerWindow(100, 50, 0, 1), null)
  const marks = rulerWindow(800, 400, 50, 10)
  assert.equal(marks.first, 0)
  assert.equal(marks.last, 40)
  assert.equal(marks.key, '800:5000')
  assert.equal(marks.width, 1064)
  assert.equal(marks.translateX, waveX(400, 0, 10, 50))
  const atStart = rulerWindow(800, 400, 50, 0)
  assert.equal(atStart.first, 0)
  assert.equal(atStart.last, 20)
  assert.equal(atStart.width, 800)
  assert.equal(atStart.translateX, 400)
  const before = rulerWindow(100, 50, 10, -5)
  assert.equal(before.first, 0)
  assert.equal(before.translateX, 100)
  const huge = rulerWindow(1e7, 5e6, 100, 1e6)
  assert.ok(huge.first >= 0)
  assert.ok(huge.last >= huge.first)
})

test('bar height and sample windows cover silence, wraparound, and a huge playhead', () => {
  assert.equal(barHeight(0, 100), 0)
  assert.equal(barHeight(-1, 100), 0)
  assert.equal(barHeight(null, 100), 0)
  assert.equal(barHeight(undefined, 40), 0)
  assert.equal(barHeight(0.01, 100), 0)
  assert.equal(barHeight(1, 100), 94)
  assert.equal(barHeight(1, 6), 2)
  assert.equal(barHeight(2, 40), barHeight(1, 40))
  assert.deepEqual(
    recordingSampleWindow({ peakCount: 0, ringSize: 16384, nowSec: 0, centerX: 200, pxPerSec: 50 }),
    { first: 0, step: 0.04 },
  )
  assert.equal(
    recordingSampleWindow({ peakCount: 20000, ringSize: 16384, nowSec: 100, centerX: 10, pxPerSec: 50 }).first,
    3616,
  )
  assert.equal(
    recordingSampleWindow({ peakCount: 10, ringSize: 16384, nowSec: 1e6, centerX: 0, pxPerSec: 1 }).first,
    Math.floor((1e6 - 4) / 0.04),
  )
  assert.deepEqual(
    playbackSampleWindow({ nowSec: 0, centerX: 0, pxPerSec: 10, width: 10, step: 1, origin: 0, length: 5 }),
    { first: 0, last: 3 },
  )
  assert.deepEqual(
    playbackSampleWindow({ nowSec: 5, centerX: 100, pxPerSec: 50, width: 400, step: 0.04, origin: 10, length: 100 }),
    { first: 63, last: 100 },
  )
  const empty = playbackSampleWindow({ nowSec: -20, centerX: 10, pxPerSec: 10, width: 20, step: 0.04, origin: 0, length: 0 })
  assert.equal(empty.first, 0)
  assert.ok(empty.last <= 0)
})

test('takes for the open text are chosen by text key and newest first', () => {
  const takes = [
    { id: 1, textKey: 'E01', createdAt: 10 },
    { id: 2, textKey: 'imp-1', createdAt: 50 },
    { id: 3, textKey: 'E01', createdAt: 30 },
    { id: 4, textKey: 'E02', createdAt: 40 },
    { id: 5, textKey: '', createdAt: 100 },
    null,
  ]
  assert.deepEqual(chooseTakes([], essay), [])
  assert.deepEqual(chooseTakes(null, essay), [])
  assert.deepEqual(chooseTakes(takes, null), [])
  assert.deepEqual(chooseTakes(takes, { kind: 'essay', code: '' }), [])
  assert.deepEqual(
    chooseTakes(takes, essay).map((take) => take.id),
    [3, 1],
  )
  assert.deepEqual(
    chooseTakes(takes, imported).map((take) => take.id),
    [2],
  )
  const tied = chooseTakes(
    [
      { id: 'a', textKey: 'E01', createdAt: 5 },
      { id: 'b', textKey: 'E01', createdAt: 5 },
    ],
    essay,
  )
  assert.deepEqual(
    tied.map((take) => take.id),
    ['a', 'b'],
  )
})

test('a stored take rounds duration and keeps the metadata', () => {
  const blob = { size: 12 }
  assert.deepEqual(
    storedTake({
      meta: { textKey: 'E01', code: 'E01', title: 'Notes' },
      result: { durationMs: 1499.6, mimeType: 'audio/mp4', extension: 'm4a', blob },
      createdAt: 123,
    }),
    {
      textKey: 'E01',
      code: 'E01',
      title: 'Notes',
      createdAt: 123,
      durationMs: 1500,
      mimeType: 'audio/mp4',
      extension: 'm4a',
      blob,
    },
  )
  assert.equal(
    storedTake({ meta: { textKey: 'E01', code: 'E01', title: 'Notes' }, result: { durationMs: -20 }, createdAt: 1 })
      .durationMs,
    0,
  )
  assert.equal(
    storedTake({
      meta: { textKey: 'E01', code: 'E01', title: 'Notes' },
      result: { durationMs: 1e15 },
      createdAt: 1,
    }).durationMs,
    1e15,
  )
  assert.equal(
    Number.isNaN(
      storedTake({ meta: { textKey: 'E01', code: 'E01', title: 'Notes' }, result: {}, createdAt: 1 }).durationMs,
    ),
    true,
  )
})

test('recorder buttons follow the capture phase and the panel mode', () => {
  assert.deepEqual(recControlState('idle'), {
    pressed: 'false',
    recording: false,
    paused: false,
    label: 'Start recording',
  })
  assert.equal(recControlState('starting').label, 'Start recording')
  assert.equal(recControlState('stopping').recording, false)
  assert.deepEqual(recControlState('recording'), {
    pressed: 'true',
    recording: true,
    paused: false,
    label: 'Stop recording',
  })
  assert.deepEqual(recControlState('paused'), {
    pressed: 'true',
    recording: true,
    paused: true,
    label: 'Stop recording, paused',
  })
  assert.equal(recordingBusy('idle'), false)
  assert.equal(recordingBusy('starting'), true)
  assert.equal(recordingBusy('recording'), true)
  assert.equal(recordingBusy('paused'), true)
  assert.equal(recordingBusy('stopping'), true)
  assert.deepEqual(micControlState({ mode: 'closed', phase: 'idle' }), { panelOpen: false, busy: false })
  assert.deepEqual(micControlState({ mode: 'closed', phase: 'starting' }), { panelOpen: false, busy: true })
  assert.deepEqual(micControlState({ mode: 'recording', phase: 'idle' }), { panelOpen: true, busy: true })
  assert.deepEqual(micControlState({ mode: 'playback', phase: 'idle' }), { panelOpen: true, busy: false })

  const recording = panelChromeState({ mode: 'recording', phase: 'paused', playbackPaused: true })
  assert.equal(recording.open, true)
  assert.equal(recording.hidden, 'false')
  assert.equal(recording.stopHidden, false)
  assert.equal(recording.pauseHidden, false)
  assert.equal(recording.pauseLabel, 'Resume recording')
  assert.equal(recording.pausePressed, 'true')
  assert.equal(recording.pauseShowsPlay, true)
  assert.equal(recording.playHidden, true)
  assert.equal(recording.closeHidden, true)
  assert.equal(recording.waveLabel, 'Recording waveform')

  const playing = panelChromeState({ mode: 'playback', phase: 'idle', playbackPaused: false })
  assert.equal(playing.playHidden, false)
  assert.equal(playing.playLabel, 'Pause')
  assert.equal(playing.playPressed, 'true')
  assert.equal(playing.playShowsPlay, false)
  assert.equal(playing.closeHidden, false)
  assert.equal(playing.stopHidden, true)
  assert.equal(playing.waveLabel, 'Playback waveform')

  const stopped = panelChromeState({ mode: 'playback', phase: 'idle', playbackPaused: true })
  assert.equal(stopped.playLabel, 'Play')
  assert.equal(stopped.playPressed, 'false')
  assert.equal(stopped.playShowsPlay, true)

  const closed = panelChromeState({ mode: 'closed', phase: 'idle', playbackPaused: true })
  assert.equal(closed.open, false)
  assert.equal(closed.hidden, 'true')
  assert.equal(closed.stopHidden, true)
  assert.equal(closed.pauseHidden, true)
  assert.equal(closed.playHidden, true)
})

test('playback time clamps to the duration and formats the clock', () => {
  assert.equal(playbackNowSec(-4, 10), 0)
  assert.equal(playbackNowSec(20, 10), 10)
  assert.equal(playbackNowSec(3, 10), 3)
  assert.equal(playbackNowSec(-5, 0), 0)
  assert.equal(playbackNowSec(5, 0), 5)
  assert.equal(playbackNowSec(5, -1), 5)
  assert.equal(playbackRatio(0, 0), 0)
  assert.equal(playbackRatio(2.5, 10), 0.25)
  assert.equal(playbackRatio(10, 10), 1)
  assert.equal(playbackClockText(0, 0), '00:00.00 / 00:00.00')
  assert.equal(playbackClockText(4080, 10000), '00:04.08 / 00:10.00')
  assert.equal(playbackClockText(-50, 1000), '00:00.00 / 00:01.00')
})
