import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readThemeStorage, setTheme, writeThemeStorage } from '../src/shell/theme.js'

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

test('theme storage prefers the current key and does not copy the legacy key', () => {
  const storage = memoryStorage({
    'teleprompter:theme': '"dark"',
    'office-essay:theme': '"light"',
  })
  assert.equal(readThemeStorage(storage), '"dark"')
  assert.equal(storage.data['office-essay:theme'], '"light"')
})

test('a missing theme key is copied from the legacy key', () => {
  const storage = memoryStorage({ 'office-essay:theme': '"dark"' })
  assert.equal(readThemeStorage(storage), '"dark"')
  assert.equal(storage.data['teleprompter:theme'], '"dark"')
  assert.equal(storage.data['office-essay:theme'], '"dark"')
})

test('theme migration still returns the legacy value when the copy cannot be stored', () => {
  const storage = memoryStorage({ 'office-essay:theme': '"dark"' }, { failSet: true })
  assert.equal(readThemeStorage(storage), '"dark"')
  assert.equal(storage.data['teleprompter:theme'], undefined)
})

test('theme storage reads and writes swallow storage failures', () => {
  assert.equal(readThemeStorage(memoryStorage({}, { failGet: true })), null)
  assert.equal(readThemeStorage(memoryStorage()), null)
  const storage = memoryStorage({}, { failSet: true })
  assert.doesNotThrow(() => writeThemeStorage('"light"', storage))
  assert.equal(storage.data['teleprompter:theme'], undefined)
})

test('theme writes the JSON string for the chosen theme', () => {
  const storage = memoryStorage()
  writeThemeStorage(JSON.stringify('dark'), storage)
  assert.equal(storage.data['teleprompter:theme'], '"dark"')
})

test('setTheme stores the choice and tells the waveform to repaint', () => {
  const root = { dataset: {} }
  const button = {
    attributes: {},
    innerHTML: '',
    setAttribute(name, value) {
      this.attributes[name] = value
    },
  }
  const previousDocument = globalThis.document
  const previousStorage = globalThis.localStorage
  globalThis.document = {
    documentElement: root,
    querySelector(selector) {
      return selector === '#theme' ? button : null
    },
  }
  globalThis.localStorage = memoryStorage()
  try {
    let paints = 0
    setTheme('dark', {
      onThemeChange() {
        paints += 1
      },
    })
    assert.equal(root.dataset.theme, 'dark')
    assert.match(button.innerHTML, /theme-icon/)
    assert.equal(button.attributes['aria-label'], 'Switch to light theme')
    assert.equal(globalThis.localStorage.data['teleprompter:theme'], '"dark"')
    assert.equal(paints, 1)

    setTheme('light', {
      onThemeChange() {
        paints += 1
      },
    })
    assert.equal(root.dataset.theme, undefined)
    assert.match(button.innerHTML, /theme-icon/)
    assert.equal(button.attributes['aria-label'], 'Switch to dark theme')
    assert.equal(globalThis.localStorage.data['teleprompter:theme'], '"light"')
    assert.equal(paints, 2)
  } finally {
    globalThis.document = previousDocument
    globalThis.localStorage = previousStorage
  }
})
