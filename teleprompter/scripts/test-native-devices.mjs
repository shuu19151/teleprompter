import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEVICE_LOST_MESSAGE,
  applyDeviceLost,
  createMicrophoneController,
  nativeMicOptions,
} from '../src/recording/microphone-controller.js'

const MIC_KEY = 'teleprompter:micId'

function optionElement() {
  return { value: '', textContent: '' }
}

function createSelect() {
  return {
    dataset: {},
    value: '',
    disabled: false,
    children: [],
    replaceChildren(...nodes) {
      this.children = nodes
    },
  }
}

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
    },
    setItem(key, value) {
      data[key] = String(value)
    },
    removeItem(key) {
      delete data[key]
    },
    data,
  }
}

function installDom(selects) {
  globalThis.document = {
    createElement() {
      return optionElement()
    },
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === 'select.mic-select') return selects
      if (selector === 'input.voice-enhance-input') return []
      return []
    },
  }
}

function labels(select) {
  return select.children.map((option) => ({ value: option.value, label: option.textContent }))
}

test('native device rows keep the menu shape and put the default first', () => {
  assert.deepEqual(nativeMicOptions(null), [])
  assert.deepEqual(
    nativeMicOptions([
      { id: 'wasapi:{usb}', name: '  USB mic  ', isDefault: false, channels: 1, sampleRates: [48000] },
      { id: 'wasapi:{laptop}', name: 'Laptop mic', isDefault: true, channels: 2, sampleRates: [44100, 48000] },
      { id: 'wasapi:{usb}', name: 'USB mic again', isDefault: false },
      { id: '', name: 'No id' },
      { id: 'wasapi:{blank}', name: '   ', isDefault: false },
    ]),
    [
      { deviceId: 'wasapi:{laptop}', label: 'Laptop mic' },
      { deviceId: 'wasapi:{usb}', label: 'USB mic' },
      { deviceId: 'wasapi:{blank}', label: 'Microphone' },
    ],
  )
})

test('the native menu fills from recorder_list_devices and refreshes on devices-changed', async () => {
  const selects = [createSelect(), createSelect()]
  installDom(selects)
  const previousStorage = globalThis.localStorage
  const storage = memoryStorage({ [MIC_KEY]: 'browser-device-hash' })
  globalThis.localStorage = storage
  const calls = []
  let listed = [
    { id: 'wasapi:{laptop}', name: 'Laptop mic', isDefault: true, channels: 2, sampleRates: [48000] },
    { id: 'wasapi:{usb}', name: 'USB mic', isDefault: false, channels: 1, sampleRates: [44100, 48000] },
  ]
  const listeners = new Map()
  const lost = []
  const starts = []

  try {
    const mic = createMicrophoneController({
      getCapture: () => ({
        phase: 'idle',
        start(_audio, options) {
          starts.push(options)
          return Promise.resolve({ started: true })
        },
      }),
      getPanelMode: () => 'closed',
      nativeDevices: {
        list() {
          calls.push('recorder_list_devices')
          return Promise.resolve(listed)
        },
        listen(name, handler) {
          const handlers = listeners.get(name) || []
          handlers.push(handler)
          listeners.set(name, handlers)
          return Promise.resolve(() => {})
        },
      },
      onDeviceLost(payload) {
        lost.push(payload)
      },
    })

    await mic.watchNativeDevices()
    assert.deepEqual(calls, ['recorder_list_devices'])
    assert.deepEqual(labels(selects[0]), [
      { value: 'wasapi:{laptop}', label: 'Laptop mic' },
      { value: 'wasapi:{usb}', label: 'USB mic' },
    ])
    assert.deepEqual(labels(selects[1]), labels(selects[0]))
    // The saved browser id is not a native id, so the menu shows the default and the key stays.
    assert.equal(selects[0].value, 'wasapi:{laptop}')
    assert.equal(selects[1].value, 'wasapi:{laptop}')
    assert.equal(storage.data[MIC_KEY], 'browser-device-hash')

    mic.onMicChange({ target: { value: 'wasapi:{usb}' } })
    assert.equal(storage.data[MIC_KEY], 'wasapi:{usb}')
    assert.equal(selects[0].value, 'wasapi:{usb}')
    assert.equal(selects[1].value, 'wasapi:{usb}')
    await mic.openCapture()
    assert.equal(starts[0].deviceId, 'wasapi:{usb}')
    assert.equal(starts[0].voiceEnhance, true)

    listed = [
      { id: 'wasapi:{laptop}', name: 'Laptop mic', isDefault: true, channels: 2, sampleRates: [48000] },
    ]
    for (const handler of listeners.get('recorder://devices-changed')) handler({ payload: { devices: listed } })
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(calls, ['recorder_list_devices', 'recorder_list_devices'])
    assert.deepEqual(labels(selects[0]), [{ value: 'wasapi:{laptop}', label: 'Laptop mic' }])
    assert.equal(selects[0].value, 'wasapi:{laptop}')
    assert.equal(storage.data[MIC_KEY], 'wasapi:{usb}')

    for (const handler of listeners.get('recorder://device-lost')) {
      handler({ payload: { deviceId: 'wasapi:{usb}' } })
    }
    assert.deepEqual(lost, [{ deviceId: 'wasapi:{usb}' }])
  } finally {
    globalThis.localStorage = previousStorage
    delete globalThis.document
  }
})

test('the web microphone list still comes from enumerateDevices', async () => {
  const selects = [createSelect()]
  installDom(selects)
  const previousStorage = globalThis.localStorage
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  globalThis.localStorage = memoryStorage()
  const seen = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices() {
          seen.push('enumerate')
          return Promise.resolve([
            { kind: 'audioinput', deviceId: 'mic-a', label: 'Desk mic' },
            { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
          ])
        },
      },
    },
  })
  try {
    const mic = createMicrophoneController({
      getCapture: () => ({ phase: 'idle' }),
      getPanelMode: () => 'closed',
    })
    await mic.refreshAudioInputs()
    assert.deepEqual(seen, ['enumerate'])
    assert.deepEqual(labels(selects[0]), [{ value: 'mic-a', label: 'Desk mic' }])
    assert.equal(selects[0].value, 'mic-a')
  } finally {
    globalThis.localStorage = previousStorage
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
    delete globalThis.document
  }
})

test('a lost device stops the take and keeps only the inline message', () => {
  const messages = []
  const finishes = []
  assert.equal(
    applyDeviceLost({
      active: true,
      finish(options) {
        finishes.push(options)
        return 'stopped'
      },
      showNotice(message) {
        messages.push(`notice:${message}`)
      },
      showRecMessage(message) {
        messages.push(message)
      },
    }),
    'stopped',
  )
  assert.deepEqual(messages, [DEVICE_LOST_MESSAGE])
  assert.deepEqual(finishes, [{ openAfter: false }])
  assert.match(DEVICE_LOST_MESSAGE, /microphone was disconnected/i)

  const idle = []
  assert.equal(
    applyDeviceLost({
      active: false,
      finish() {
        idle.push('finish')
      },
      showRecMessage(message) {
        idle.push(message)
      },
    }),
    undefined,
  )
  assert.deepEqual(idle, [DEVICE_LOST_MESSAGE])
})
