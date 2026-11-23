import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadJSON, readStorage, writeStorage } from '../src/shared/storage.js'

function memoryStorage(initial = {}, { failSet = false, failGet = false } = {}) {
  const data = { ...initial }
  return {
    getItem(key) {
      if (failGet) throw new Error('denied')
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
    },
    setItem(key, value) {
      if (failSet) throw new Error('quota')
      data[key] = String(value)
    },
    data,
  }
}

test('speed storage prefers the current key and does not copy the legacy key', () => {
  const storage = memoryStorage({
    'teleprompter:speed': '20',
    'office-essay:speed': '40',
  })
  assert.equal(readStorage('teleprompter:speed', storage), '20')
  assert.equal(storage.data['office-essay:speed'], '40')
})

test('a missing speed key is copied from the legacy key', () => {
  const storage = memoryStorage({ 'office-essay:speed': '32' })
  assert.equal(readStorage('teleprompter:speed', storage), '32')
  assert.equal(storage.data['teleprompter:speed'], '32')
  assert.equal(storage.data['office-essay:speed'], '32')
})

test('speed migration still returns the legacy value when the copy cannot be stored', () => {
  const storage = memoryStorage({ 'office-essay:speed': '32' }, { failSet: true })
  assert.equal(readStorage('teleprompter:speed', storage), '32')
  assert.equal(storage.data['teleprompter:speed'], undefined)
})

test('other keys are not copied from a legacy name', () => {
  const storage = memoryStorage({ 'office-essay:fontSize': '44' })
  assert.equal(readStorage('teleprompter:fontSize', storage), null)
  assert.equal(loadJSON('teleprompter:position', storage), null)
})

test('loadJSON parses a stored value and ignores invalid JSON', () => {
  const storage = memoryStorage({ 'teleprompter:fontSize': '44', 'teleprompter:position': '{' })
  assert.equal(loadJSON('teleprompter:fontSize', storage), 44)
  assert.equal(loadJSON('teleprompter:position', storage), null)
})

test('a denied read returns null and a denied write is ignored', () => {
  assert.equal(readStorage('teleprompter:speed', memoryStorage({}, { failGet: true })), null)
  const full = memoryStorage({}, { failSet: true })
  writeStorage('teleprompter:speed', '20', full)
  assert.equal(full.data['teleprompter:speed'], undefined)
})
