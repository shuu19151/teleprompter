import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capturedPlace, savedReadingPosition } from '../src/reading/reader-progress.js'

const id = 'E01-how-i-stay-productive-and-calm.txt'

test('captured place keeps the active line, then the anchor, then the top', () => {
  assert.deepEqual(capturedPlace(4, { index: 4, fraction: 0.18 }), { index: 4, fraction: 0.18 })
  assert.deepEqual(capturedPlace(0, { index: 0, fraction: 0 }), { index: 0, fraction: 0 })
  assert.deepEqual(capturedPlace(-1, { index: 3, fraction: 0.5 }), { index: 3, fraction: 0.5 })
  assert.deepEqual(capturedPlace(-1, null), { index: 0, fraction: 0 })
  assert.deepEqual(capturedPlace(-1, undefined), { index: 0, fraction: 0 })
  assert.deepEqual(capturedPlace(2, { index: 4, fraction: 0.9 }), { index: 2, fraction: 0 })
  assert.deepEqual(capturedPlace(2, { index: 2, fraction: Number.NaN }), { index: 2, fraction: 0 })
  assert.deepEqual(capturedPlace(2, { index: 2, fraction: Number.POSITIVE_INFINITY }), { index: 2, fraction: 0 })
  assert.deepEqual(capturedPlace(-1, { index: -3, fraction: 0.2 }), { index: 0, fraction: 0.2 })
})

test('the position slot is either a line or an offset, never both', () => {
  assert.deepEqual(savedReadingPosition({ hasLine: true, index: 4, fraction: 0.18, offset: 120, id }), {
    index: 4,
    fraction: 0.18,
    id,
  })
  assert.deepEqual(savedReadingPosition({ hasLine: false, index: 4, fraction: 0.18, offset: 120, id }), {
    offset: 120,
    id,
  })
  assert.deepEqual(savedReadingPosition({ hasLine: false, offset: 0, id: 'imp-1' }), { offset: 0, id: 'imp-1' })
  assert.equal('index' in savedReadingPosition({ hasLine: false, index: 1, fraction: 0, offset: 8, id }), false)
  assert.equal('offset' in savedReadingPosition({ hasLine: true, index: 1, fraction: 0, offset: 8, id }), false)
})
