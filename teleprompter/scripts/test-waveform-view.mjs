import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyPeakBatch, exportPeakSlice, meterLevel, nextWaveColors, playbackDurationSec, recordingBarTimeSec } from '../src/recording/waveform-view.js'

test('peak export keeps the newest samples once the ring wraps', () => {
  const ring = new Float32Array(4)
  let count = 0
  for (const level of [10, 11, 12, 13, 14, 15]) {
    ring[count % 4] = level
    count += 1
  }
  const exported = exportPeakSlice(ring, count, 4)
  assert.equal(exported.origin, 2)
  assert.deepEqual([...exported.peaks], [12, 13, 14, 15])

  const short = exportPeakSlice(ring, 2, 4)
  assert.equal(short.origin, 0)
  assert.deepEqual([...short.peaks], [14, 15])
})

test('playback duration prefers the audio element, then the decode, then the take', () => {
  assert.equal(playbackDurationSec(null), 0)
  assert.equal(playbackDurationSec({}), 0)
  assert.equal(playbackDurationSec({ take: { durationMs: 2500 } }), 2.5)
  assert.equal(playbackDurationSec({ decodedDuration: 3.25, take: { durationMs: 2500 } }), 3.25)
  assert.equal(
    playbackDurationSec({ audio: { duration: 4 }, decodedDuration: 3.25, take: { durationMs: 2500 } }),
    4,
  )
  assert.equal(
    playbackDurationSec({ audio: { duration: Infinity }, decodedDuration: 3.25, take: { durationMs: 2500 } }),
    3.25,
  )
  assert.equal(playbackDurationSec({ audio: { duration: Number.NaN }, take: { durationMs: 0 } }), 0)
})

test('a meter uses the same peak and rms mix as the live waveform', () => {
  assert.equal(meterLevel(null), 0)
  assert.equal(meterLevel({ peak: 0.4, rms: 0.2 }), 0.5)
  assert.equal(meterLevel({ peak: 0.2, rms: 0.1 }), 0.25)
  assert.equal(meterLevel({ peak: 1.4, rms: 0.2, clipped: true }), 1)
  assert.equal(meterLevel({ peak: Number.NaN, rms: 0.1 }), 0.25)
})

test('the first native bar is the kept-sample onset, one 20 ms bin in', () => {
  assert.equal(recordingBarTimeSec(0, 0.02), 0.01)
  assert.equal(recordingBarTimeSec(1, 0.02), 0.03)
  assert.equal(recordingBarTimeSec(16, 0.02), 0.33)
  assert.equal(recordingBarTimeSec(0, 0), 0)
  assert.equal(recordingBarTimeSec(-1, 0.02), 0)
  // Dropped leading silence is not part of the index. Two seconds of it
  // must not push the first bar to 2.00s or to the 0.40s ruler tick.
  assert.ok(recordingBarTimeSec(0, 0.02) < 0.02)
  assert.ok(Math.abs(recordingBarTimeSec(0, 0.02) - 0.4) > 0.2)
})

test('native peak batches land on their start index', () => {
  const ring = new Float32Array(4)
  let count = applyPeakBatch(ring, 0, 4, { startIndex: 0, values: [0.25, 0.5] })
  assert.equal(count, 2)
  assert.deepEqual([...ring], [0.25, 0.5, 0, 0])
  count = applyPeakBatch(ring, count, 4, { startIndex: 2, values: [0.75, 1.5, -1] })
  assert.equal(count, 5)
  assert.deepEqual([...ring], [0, 0.5, 0.75, 1])
  assert.equal(applyPeakBatch(ring, count, 4, null), count)
  assert.equal(applyPeakBatch(ring, count, 0, { values: [1] }), count)
})

test('wave colors stay cached until the theme key is cleared', () => {
  const cached = { theme: 'light', wave: '#aaa', ink: '#111', line: '#222' }
  assert.equal(nextWaveColors(cached, 'light', { wave: '', ink: '', line: '' }), cached)
  assert.deepEqual(nextWaveColors({ theme: '', ink: '', line: '' }, 'dark', { wave: '', ink: '#eee', line: '' }), {
    theme: 'dark',
    wave: '#6f6961',
    ink: '#eee',
    line: '#c6bbac',
  })
})
