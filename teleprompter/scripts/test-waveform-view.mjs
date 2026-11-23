import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportPeakSlice, nextWaveColors, playbackDurationSec } from '../src/recording/waveform-view.js'

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
