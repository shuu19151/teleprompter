import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FONT_DEFAULT, FONT_MAX, FONT_MIN, clampFontSize, parseFontSize } from '../src/reading/reader-layout.js'

test('font size accepts integers in the slider range and falls back to 32', () => {
  assert.equal(FONT_MIN, 24)
  assert.equal(FONT_MAX, 56)
  assert.equal(FONT_DEFAULT, 32)
  assert.equal(parseFontSize(32), 32)
  assert.equal(parseFontSize(24), 24)
  assert.equal(parseFontSize(56), 56)
  assert.equal(parseFontSize('44'), 44)
  assert.equal(parseFontSize(23), FONT_DEFAULT)
  assert.equal(parseFontSize(57), FONT_DEFAULT)
  assert.equal(parseFontSize(32.5), FONT_DEFAULT)
  assert.equal(parseFontSize(null), FONT_DEFAULT)
  assert.equal(parseFontSize(undefined), FONT_DEFAULT)
  assert.equal(parseFontSize('nope'), FONT_DEFAULT)
  assert.equal(parseFontSize(Number.NaN), FONT_DEFAULT)
})

test('font size slider values clamp to an integer in range', () => {
  assert.equal(clampFontSize(32), 32)
  assert.equal(clampFontSize('40'), 40)
  assert.equal(clampFontSize(23.2), 24)
  assert.equal(clampFontSize(56.6), 56)
  assert.equal(clampFontSize(40.5), 41)
  assert.equal(clampFontSize(0), 24)
  assert.equal(clampFontSize(null), 24)
  assert.equal(clampFontSize(''), 24)
  assert.equal(clampFontSize('nope'), null)
  assert.equal(clampFontSize(undefined), null)
  assert.equal(clampFontSize(Number.POSITIVE_INFINITY), 56)
})
