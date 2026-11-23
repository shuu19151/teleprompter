import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SPEED_DEFAULT,
  SPEED_MAX,
  SPEED_MIN,
  advanceReading,
  parseSpeed,
  wheelDistance,
} from '../src/reading/reader-controller.js'

test('speed accepts JSON integers from 1 to 50 and falls back to 20', () => {
  assert.equal(SPEED_MIN, 1)
  assert.equal(SPEED_MAX, 50)
  assert.equal(SPEED_DEFAULT, 20)
  assert.equal(parseSpeed(null), 20)
  assert.equal(parseSpeed('20'), 20)
  assert.equal(parseSpeed('1'), 1)
  assert.equal(parseSpeed('50'), 50)
  assert.equal(parseSpeed('"44"'), 44)
  assert.equal(parseSpeed('0'), 20)
  assert.equal(parseSpeed('51'), 20)
  assert.equal(parseSpeed('20.5'), 20)
  assert.equal(parseSpeed('true'), 1)
  assert.equal(parseSpeed('not json'), 20)
  assert.equal(parseSpeed(undefined), 20)
  assert.equal(parseSpeed(''), 20)
})

test('wheel distance follows delta mode, including a missing page height', () => {
  assert.equal(wheelDistance(0, 12, 400), 12)
  assert.equal(wheelDistance(1, 2, 400), 32)
  assert.equal(wheelDistance(1, -1, 400), -16)
  assert.equal(wheelDistance(2, 1, 400), 400)
  assert.equal(wheelDistance(2, 1, 0), 0)
  assert.equal(wheelDistance(2, 1, undefined), 0)
  assert.equal(wheelDistance(2, 1, null), 0)
})

test('reading advance scrolls, glides, and stops at the ends', () => {
  assert.deepEqual(advanceReading({ offset: 0, running: true, wheelLeft: 0, dt: 0.1, rate: 50, limit: 1000 }), {
    offset: 5,
    wheelLeft: 0,
    running: true,
    reachedEnd: false,
  })

  const ended = advanceReading({ offset: 99, running: true, wheelLeft: 0, dt: 0.1, rate: 50, limit: 100 })
  assert.equal(ended.offset, 100)
  assert.equal(ended.running, false)
  assert.equal(ended.reachedEnd, true)
  assert.equal(ended.wheelLeft, 0)

  const exact = advanceReading({ offset: 100, running: true, wheelLeft: 0, dt: 0.1, rate: 0, limit: 100 })
  assert.equal(exact.offset, 100)
  assert.equal(exact.reachedEnd, true)

  const gliding = advanceReading({ offset: 0, running: false, wheelLeft: 100, dt: 0.16, rate: 50, limit: 1000 })
  const glide = 100 * (1 - Math.exp(-1))
  assert.ok(Math.abs(gliding.offset - glide) < 1e-9)
  assert.ok(Math.abs(gliding.wheelLeft - (100 - glide)) < 1e-9)
  assert.equal(gliding.running, false)
  assert.equal(gliding.reachedEnd, false)

  const above = advanceReading({ offset: 10, running: true, wheelLeft: 0.5, dt: 0, rate: 50, limit: 1000 })
  assert.equal(above.offset, 10)
  assert.equal(above.wheelLeft, 0.5)
  assert.equal(above.running, true)

  const topped = advanceReading({ offset: 0, running: false, wheelLeft: -10, dt: 1, rate: 50, limit: 1000 })
  assert.equal(topped.offset, 0)
  assert.equal(topped.wheelLeft, 0)
  assert.equal(topped.reachedEnd, false)

  const intoEnd = advanceReading({ offset: 90, running: false, wheelLeft: 40, dt: 1, rate: 50, limit: 100 })
  assert.equal(intoEnd.offset, 100)
  assert.equal(intoEnd.running, false)
  assert.equal(intoEnd.reachedEnd, false)
  assert.ok(intoEnd.wheelLeft <= 0)
})
