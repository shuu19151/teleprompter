import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  READING_RATIO,
  anchorOffset,
  clampOffset,
  findActiveIndex,
  formatRemaining,
  fractionAtOffset,
  offsetForFraction,
  pixelsPerSecond,
  progressRatio,
  readingFromTop,
  remainingSeconds,
  restoreOffset,
  scriptFocusY,
} from '../src/reading/reader-math.js'

const view = { readingFromTop: 80, focusShift: 8 }

function line(top, height) {
  return { top, height, center: top + height / 2 }
}

const lines = [line(100, 20), line(140, 20), line(200, 40), line(260, 20)]

test('speed, guide, and focus stay on the one-third line', () => {
  assert.equal(READING_RATIO, 1 / 3)
  assert.equal(pixelsPerSecond(20), 50)
  assert.equal(pixelsPerSecond(1), 2.5)
  assert.equal(pixelsPerSecond(0), 0)
  assert.equal(pixelsPerSecond(-4), -10)
  assert.equal(readingFromTop(0), 0)
  assert.equal(readingFromTop(300), 100)
  assert.equal(readingFromTop(-30), -10)
  assert.equal(scriptFocusY({ offset: 40, height: 300, focusShift: 8 }), 132)
  assert.equal(scriptFocusY({ offset: 0, height: 0, focusShift: 0 }), 0)
  assert.equal(scriptFocusY({ offset: -20, height: 90, focusShift: 4 }), 6)
})

test('offset and fraction convert through a measured line', () => {
  const focus = scriptFocusY({ offset: 58, height: 240, focusShift: view.focusShift })
  assert.equal(offsetForFraction(100, 20, 0, view), 100 - view.readingFromTop + view.focusShift)
  assert.equal(offsetForFraction(100, 20, 1, view), 120 - view.readingFromTop + view.focusShift)
  assert.equal(offsetForFraction(100, 20, -1, view), 80 - view.readingFromTop + view.focusShift)
  assert.equal(offsetForFraction(0, 0, 0, { readingFromTop: 0, focusShift: 0 }), 0)
  assert.equal(offsetForFraction(10, 1e6, 2, { readingFromTop: 0, focusShift: 0 }), 10 + 2e6)
  assert.equal(fractionAtOffset(100, 20, 100), 0)
  assert.equal(fractionAtOffset(100, 20, 110), 0.5)
  assert.equal(fractionAtOffset(100, 20, 140), 2)
  assert.equal(fractionAtOffset(100, 0, 130), 30)
  assert.equal(fractionAtOffset(100, 0, 100), 0)
  const fraction = fractionAtOffset(100, 20, focus)
  const back = offsetForFraction(100, 20, fraction, { readingFromTop: 80, focusShift: 8 })
  assert.equal(back, 58)
})

test('active line clamps to the measured lines and prefers the nearer center', () => {
  assert.equal(findActiveIndex([], -100), 0)
  assert.equal(findActiveIndex([], 1e9), 0)
  assert.equal(findActiveIndex([lines[0]], 0), 0)
  assert.equal(findActiveIndex([lines[0]], 1e9), 0)
  assert.equal(findActiveIndex(lines, -1e6), 0)
  assert.equal(findActiveIndex(lines, lines[0].center), 0)
  assert.equal(findActiveIndex(lines, 1e9), lines.length - 1)
  assert.equal(findActiveIndex(lines, lines[2].center), 2)
  const between = (lines[1].center + lines[2].center) / 2
  assert.equal(findActiveIndex(lines, between), 1)
  assert.equal(findActiveIndex(lines, between + 0.01), 2)
  assert.equal(findActiveIndex(lines, lines[1].center + 0.01), 1)
})

test('anchor restore clamps zero, negative, and huge offsets', () => {
  assert.equal(anchorOffset({ anchor: null, metrics: lines, width: 1, height: 2, max: 500, ...view }), null)
  assert.equal(
    anchorOffset({
      anchor: { index: 1, fraction: 0.5, width: 400, height: 300 },
      metrics: [],
      width: 200,
      height: 100,
      max: 500,
      ...view,
    }),
    null,
  )
  assert.equal(
    anchorOffset({
      anchor: { index: 1, fraction: 0.25, width: 400, height: 300 },
      metrics: lines,
      width: 400,
      height: 300,
      max: 500,
      ...view,
    }),
    null,
  )
  assert.equal(
    anchorOffset({
      anchor: { index: 9, fraction: 0.5, width: -1, height: -1 },
      metrics: lines,
      width: 400,
      height: 300,
      max: 500,
      ...view,
    }),
    null,
  )
  const raw = offsetForFraction(lines[0].top, lines[0].height, -2, view)
  assert.ok(raw < 0)
  assert.equal(
    anchorOffset({
      anchor: { index: 0, fraction: -2, width: -1, height: -1 },
      metrics: lines,
      width: 400,
      height: 300,
      max: 500,
      ...view,
    }),
    0,
  )
  assert.equal(
    anchorOffset({
      anchor: { index: 2, fraction: 50, width: -1, height: -1 },
      metrics: lines,
      width: 10,
      height: 10,
      max: 480,
      ...view,
    }),
    480,
  )
  assert.equal(clampOffset(-20, 0), 0)
  assert.equal(clampOffset(1e12, 0), 0)
  assert.equal(clampOffset(12, 400), 12)
  assert.equal(clampOffset(-1, 400), 0)
  assert.equal(clampOffset(1e9, 400), 400)
})

test('remaining time and progress cover an empty, finished, and overrun script', () => {
  assert.equal(formatRemaining(0), '0:00 left')
  assert.equal(formatRemaining(0.4), '0:00 left')
  assert.equal(formatRemaining(0.5), '0:01 left')
  assert.equal(formatRemaining(59.5), '1:00 left')
  assert.equal(formatRemaining(3600), '60:00 left')
  assert.equal(formatRemaining(-8), '0:00 left')
  assert.equal(formatRemaining(Number.NaN), '0:00 left')
  assert.equal(formatRemaining(Number.POSITIVE_INFINITY), '0:00 left')
  assert.equal(progressRatio(0, 0), 0)
  assert.equal(progressRatio(-40, 0), 0)
  assert.equal(progressRatio(1e9, 0), 0)
  assert.equal(progressRatio(-10, 200), 0)
  assert.equal(progressRatio(50, 200), 0.25)
  assert.equal(progressRatio(500, 200), 1)
  assert.equal(progressRatio(0, 200), 0)
  assert.equal(remainingSeconds(0, 200, 50), 4)
  assert.equal(remainingSeconds(200, 200, 50), 0)
  assert.equal(remainingSeconds(500, 200, 50), 0)
  assert.equal(remainingSeconds(-20, 200, 50), 4.4)
  assert.equal(remainingSeconds(0, 200, 0), 0)
  assert.equal(remainingSeconds(0, 200, -5), 0)
  assert.equal(remainingSeconds(0, 0, 50), 0)
})

test('restore uses a line fraction, then a legacy offset, and ignores a bad index', () => {
  const savedLine = restoreOffset({
    saved: { index: 1, fraction: 0.5, offset: 1, id: 'E01' },
    lineMetrics: lines,
    max: 500,
    ...view,
  })
  assert.deepEqual(savedLine.restoredAnchor, { index: 1, fraction: 0.5 })
  assert.deepEqual(savedLine.anchor, { index: 1, fraction: 0.5, width: -1, height: -1 })
  assert.equal(savedLine.offset, clampOffset(offsetForFraction(lines[1].top, lines[1].height, 0.5, view), 500))

  const negative = restoreOffset({
    saved: { index: 0, fraction: -4 },
    lineMetrics: lines,
    max: 500,
    ...view,
  })
  assert.equal(negative.offset, 0)

  const huge = restoreOffset({
    saved: { index: 3, fraction: 1e6 },
    lineMetrics: lines,
    max: 220,
    ...view,
  })
  assert.equal(huge.offset, 220)
  assert.equal(huge.anchor.index, 3)

  assert.deepEqual(
    restoreOffset({ saved: { offset: 120 }, lineMetrics: lines, max: 500, ...view }),
    { offset: 120 },
  )
  assert.deepEqual(
    restoreOffset({ saved: { offset: 0 }, lineMetrics: [], max: 0, ...view }),
    { offset: 0 },
  )
  assert.deepEqual(
    restoreOffset({ saved: { offset: -80 }, lineMetrics: [], max: 400, ...view }),
    { offset: 0 },
  )
  assert.deepEqual(
    restoreOffset({ saved: { offset: 1e15 }, lineMetrics: [], max: 400, ...view }),
    { offset: 400 },
  )
  assert.deepEqual(
    restoreOffset({ saved: { index: '2', fraction: 0.2, offset: -5 }, lineMetrics: lines, max: 400, ...view }),
    { offset: 0 },
  )
  assert.deepEqual(
    restoreOffset({ saved: { index: 1.5, fraction: 0.2, offset: 12 }, lineMetrics: lines, max: 400, ...view }),
    { offset: 12 },
  )
  assert.deepEqual(
    restoreOffset({ saved: { index: 20, fraction: 0.2, offset: 15 }, lineMetrics: lines, max: 400, ...view }),
    { offset: 15 },
  )
  assert.deepEqual(
    restoreOffset({ saved: { index: -1, fraction: 0, offset: 8 }, lineMetrics: lines, max: 400, ...view }),
    { offset: 8 },
  )
  assert.deepEqual(
    restoreOffset({ saved: { index: 0, fraction: Number.NaN, offset: 40 }, lineMetrics: lines, max: 400, ...view }),
    { offset: 40 },
  )
  assert.equal(
    restoreOffset({ saved: { index: 0, fraction: Number.POSITIVE_INFINITY, offset: Number.POSITIVE_INFINITY }, lineMetrics: lines, max: 400, ...view }),
    null,
  )
  assert.equal(restoreOffset({ saved: {}, lineMetrics: lines, max: 400, ...view }), null)
  assert.equal(restoreOffset({ saved: { offset: Number.NaN }, lineMetrics: [], max: 10, ...view }), null)
})
