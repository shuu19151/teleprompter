import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMicrophoneController } from '../src/recording/microphone-controller.js'
import { MIC_DENIED_MESSAGE } from '../src/recording/rec-messages.js'

const VOICE_KEY = 'teleprompter:voiceEnhance'
const MIC_KEY = 'teleprompter:micId'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  const removed = []
  return {
    data,
    removed,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
    },
    setItem(key, value) {
      data[key] = String(value)
    },
    removeItem(key) {
      removed.push(key)
      delete data[key]
    },
  }
}

function installDom() {
  const select = {
    dataset: {},
    value: '',
    disabled: false,
    children: [],
    replaceChildren(...nodes) {
      this.children = nodes
    },
  }
  const previous = globalThis.document
  globalThis.document = {
    visibilityState: 'visible',
    createElement() {
      return { value: '', textContent: '' }
    },
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === 'select.mic-select') return [select]
      return []
    },
  }
  return {
    select,
    restore() {
      if (previous === undefined) delete globalThis.document
      else globalThis.document = previous
    },
  }
}

function fakeCapture() {
  const calls = []
  let active = false
  let phase = 'idle'
  return {
    calls,
    usesWebCapture: true,
    get phase() {
      return phase
    },
    set phase(value) {
      phase = value
    },
    isActive() {
      return active
    },
    setActive(value) {
      active = value
    },
    prepare(_audio, options) {
      calls.push({ type: 'prepare', options })
      if (options.fail) {
        const error = new Error('mic')
        error.name = options.fail
        return Promise.reject(error)
      }
      return Promise.resolve({ prepared: true, reused: calls.filter((call) => call.type === 'prepare').length > 1 })
    },
    releasePrepared() {
      calls.push({ type: 'release' })
      active = false
      phase = 'idle'
      return true
    },
    start(_audio, options) {
      calls.push({ type: 'start', options })
      active = true
      phase = 'recording'
      return Promise.resolve({ started: true })
    },
  }
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

test('voice enhance stays on and the stored checkbox is left untouched', async () => {
  const dom = installDom()
  const previous = globalThis.localStorage
  const storage = memoryStorage({ [VOICE_KEY]: 'false', [MIC_KEY]: 'mic-a' })
  globalThis.localStorage = storage
  const capture = fakeCapture()
  try {
    const mic = createMicrophoneController({
      getCapture: () => capture,
      getPanelMode: () => 'closed',
    })
    await mic.openCapture()
    assert.equal(capture.calls[0].type, 'start')
    assert.equal(capture.calls[0].options.voiceEnhance, true)
    assert.equal(capture.calls[0].options.deviceId, 'mic-a')
    assert.equal(storage.data[VOICE_KEY], 'false')
    assert.equal(storage.removed.includes(VOICE_KEY), false)
    assert.equal(mic.isVoiceEnhance, undefined)
    assert.equal(mic.onVoiceEnhanceChange, undefined)
  } finally {
    globalThis.localStorage = previous
    dom.restore()
  }
})

test('the reader acquires a warmed mic, replaces it on change, and releases it when leaving', async () => {
  const dom = installDom()
  const previous = globalThis.localStorage
  globalThis.localStorage = memoryStorage({ [MIC_KEY]: 'mic-a' })
  const capture = fakeCapture()
  const messages = []
  const ready = []
  const stops = []
  try {
    const mic = createMicrophoneController({
      getCapture: () => capture,
      getPanelMode: () => 'closed',
      showRecMessage(message) {
        messages.push(message)
      },
      onMicReady() {
        ready.push('ready')
      },
      stopIfActive() {
        stops.push('stop')
        capture.setActive(false)
        capture.phase = 'idle'
        return Promise.resolve(null)
      },
    })

    mic.noteReaderOpen(true)
    await flush()
    assert.equal(capture.calls[0].type, 'prepare')
    assert.equal(capture.calls[0].options.deviceId, 'mic-a')
    assert.equal(capture.calls[0].options.voiceEnhance, true)
    assert.deepEqual(ready, ['ready'])
    assert.deepEqual(messages, [])

    mic.onMicChange({ target: { value: 'mic-b' } })
    await flush()
    const prepared = capture.calls.filter((call) => call.type === 'prepare')
    assert.equal(prepared.at(-1).options.deviceId, 'mic-b')
    assert.equal(prepared.at(-1).options.voiceEnhance, true)

    capture.setActive(true)
    capture.phase = 'recording'
    mic.notePageVisibility(false)
    await flush()
    assert.deepEqual(stops, ['stop'])
    assert.equal(capture.calls.at(-1).type, 'release')

    mic.notePageVisibility(true)
    await flush()
    assert.equal(capture.calls.at(-1).type, 'prepare')

    const beforeLeave = capture.calls.length
    mic.noteReaderOpen(false)
    await flush()
    assert.equal(capture.calls[beforeLeave].type, 'release')
    assert.equal(capture.calls.filter((call) => call.type === 'prepare').length, prepared.length + 1)
  } finally {
    globalThis.localStorage = previous
    dom.restore()
  }
})

test('a hidden page does not open the mic, and a failed open uses the rec message', async () => {
  const dom = installDom()
  globalThis.document.visibilityState = 'hidden'
  const previous = globalThis.localStorage
  globalThis.localStorage = memoryStorage()
  const capture = fakeCapture()
  const messages = []
  const ready = []
  try {
    const mic = createMicrophoneController({
      getCapture: () => capture,
      getPanelMode: () => 'closed',
      showRecMessage(message) {
        messages.push(message)
      },
      onMicReady() {
        ready.push('ready')
      },
    })
    mic.noteReaderOpen(true)
    await flush()
    assert.equal(capture.calls.filter((call) => call.type === 'prepare').length, 0)

    mic.notePageVisibility(true)
    await flush()
    const opened = capture.calls.filter((call) => call.type === 'prepare')
    assert.equal(opened.length, 1)
    assert.equal(opened[0].options.voiceEnhance, true)
    assert.deepEqual(ready, ['ready'])

    capture.prepare = (_audio, options) => {
      capture.calls.push({ type: 'prepare', options })
      const error = new Error('denied')
      error.name = 'NotAllowedError'
      return Promise.reject(error)
    }
    mic.onMicChange({ target: { value: 'mic-c' } })
    await flush()
    assert.deepEqual(messages, [MIC_DENIED_MESSAGE])

    capture.prepare = (_audio, options) => {
      capture.calls.push({ type: 'prepare', options })
      if (options.deviceId === 'missing') {
        const error = new Error('missing')
        error.name = 'NotFoundError'
        return Promise.reject(error)
      }
      return Promise.resolve({ prepared: true })
    }
    messages.length = 0
    ready.length = 0
    globalThis.localStorage.setItem(MIC_KEY, 'missing')
    mic.onMicChange({ target: { value: 'missing' } })
    await flush()
    const devices = capture.calls.filter((call) => call.type === 'prepare').slice(-2)
    assert.equal(devices[0].options.deviceId, 'missing')
    assert.equal(devices[1].options.deviceId, '')
    assert.deepEqual(messages, [])
    assert.deepEqual(ready, ['ready'])
    assert.equal(globalThis.localStorage.getItem(MIC_KEY), null)
  } finally {
    globalThis.localStorage = previous
    dom.restore()
  }
})

test('a native recorder is not warmed through getUserMedia', async () => {
  const dom = installDom()
  const previous = globalThis.localStorage
  globalThis.localStorage = memoryStorage()
  const capture = fakeCapture()
  capture.usesWebCapture = false
  capture.releasePrepared = undefined
  try {
    const mic = createMicrophoneController({
      getCapture: () => capture,
      getPanelMode: () => 'closed',
    })
    mic.noteReaderOpen(true)
    mic.notePageVisibility(false)
    await flush()
    assert.deepEqual(capture.calls, [])
  } finally {
    globalThis.localStorage = previous
    dom.restore()
  }
})
