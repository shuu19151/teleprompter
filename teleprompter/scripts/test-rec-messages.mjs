import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMicrophoneController } from '../src/recording/microphone-controller.js'
import {
  DELETE_TAKE_MESSAGE,
  DEVICE_LOST_MESSAGE,
  DISK_TAKE_MESSAGE,
  MIC_DENIED_MESSAGE,
  MIC_FAILED_MESSAGE,
  MIC_UNOPENABLE_MESSAGE,
  NO_MIC_MESSAGE,
  QUOTA_TAKE_MESSAGE,
  SAVE_TAKE_MESSAGE,
  SHOW_TAKE_MESSAGE,
  START_RECORDING_MESSAGE,
  describeMediaError,
  recMessageAfter,
  recorderMessageChannel,
} from '../src/recording/rec-messages.js'
import { describeMediaError as describeMediaErrorFromRecording } from '../src/recording/recording.js'
import { createRecorderView, recMessageMarkup } from '../src/recording/recorder-view.js'

const INLINE = [
  MIC_FAILED_MESSAGE,
  DEVICE_LOST_MESSAGE,
  MIC_DENIED_MESSAGE,
  NO_MIC_MESSAGE,
  MIC_UNOPENABLE_MESSAGE,
  START_RECORDING_MESSAGE,
  QUOTA_TAKE_MESSAGE,
  SAVE_TAKE_MESSAGE,
  DISK_TAKE_MESSAGE,
]

function messageElement() {
  const text = { textContent: '' }
  const button = {
    closest(selector) {
      return selector === '[data-rec-dismiss]' ? button : null
    },
  }
  return {
    hidden: true,
    text,
    button,
    querySelector(selector) {
      if (selector === '[data-rec-message-text]') return text
      return null
    },
  }
}

function installDocument(messages) {
  const clicks = []
  const previous = globalThis.document
  globalThis.document = {
    addEventListener(type, handler) {
      if (type === 'click') clicks.push(handler)
    },
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-rec-message]') return messages
      if (selector === 'select.mic-select') return []
      if (selector === 'input.voice-enhance-input') return []
      return []
    },
  }
  return {
    clicks,
    restore() {
      if (previous === undefined) delete globalThis.document
      else globalThis.document = previous
    },
  }
}

function viewWith() {
  return createRecorderView({
    getVoiceEnhance: () => false,
    getPanelMode: () => 'closed',
    getCapturePhase: () => 'idle',
    getPlayback: () => null,
    syncMicControls: () => {},
  })
}

function visibleText(messages) {
  return messages.map((message) => ({ hidden: message.hidden, text: message.text.textContent }))
}

test('mic and save failures stay inline, and delete or reveal failures toast', () => {
  for (const message of INLINE) assert.equal(recorderMessageChannel(message), 'inline')
  assert.equal(recorderMessageChannel(DELETE_TAKE_MESSAGE), 'toast')
  assert.equal(recorderMessageChannel(SHOW_TAKE_MESSAGE), 'toast')
  assert.equal(recorderMessageChannel('Recording needs https or localhost.'), null)
  assert.equal(recorderMessageChannel('This browser cannot record audio.'), null)
  assert.equal(recorderMessageChannel(''), null)
})

test('https and unsupported recording use the generic start message', () => {
  assert.equal(describeMediaError, describeMediaErrorFromRecording)
  assert.equal(describeMediaError({ name: 'NotAllowedError' }), MIC_DENIED_MESSAGE)
  assert.equal(describeMediaError({ name: 'PermissionDeniedError' }), MIC_DENIED_MESSAGE)
  assert.equal(describeMediaError({ name: 'NotFoundError' }), NO_MIC_MESSAGE)
  assert.equal(describeMediaError({ name: 'DevicesNotFoundError' }), NO_MIC_MESSAGE)
  assert.equal(describeMediaError({ name: 'NotReadableError' }), MIC_UNOPENABLE_MESSAGE)
  assert.equal(describeMediaError({ name: 'TrackStartError' }), MIC_UNOPENABLE_MESSAGE)
  assert.equal(describeMediaError({ name: 'AbortError' }), MIC_UNOPENABLE_MESSAGE)
  assert.equal(describeMediaError({ name: 'SecurityError' }), START_RECORDING_MESSAGE)
  assert.equal(describeMediaError({ name: 'NotSupportedError' }), START_RECORDING_MESSAGE)
  assert.equal(describeMediaError({ name: 'UnknownError' }), START_RECORDING_MESSAGE)
  assert.equal(describeMediaError(null), START_RECORDING_MESSAGE)
  for (const name of ['SecurityError', 'NotSupportedError', 'NotAllowedError', 'NotFoundError', 'AbortError']) {
    assert.equal(recorderMessageChannel(describeMediaError({ name })), 'inline')
  }
})

test('the inline message carries a dismiss button', () => {
  for (const markup of [recMessageMarkup(), recMessageMarkup('rec-message rec-stage-message')]) {
    assert.match(markup, /class="[^"]*\bbtn\b[^"]*\brec-message-dismiss\b/)
    assert.match(markup, /aria-label="Dismiss"/)
    assert.match(markup, />✕</)
    assert.match(markup, /data-rec-message/)
    assert.match(markup, /hidden/)
  }
  assert.match(recMessageMarkup('rec-message rec-stage-message'), /rec-stage-message/)
})

test('dismiss hides the inline message', () => {
  const messages = [messageElement(), messageElement()]
  const dom = installDocument(messages)
  try {
    const view = viewWith()
    view.showRecMessage(MIC_DENIED_MESSAGE)
    assert.deepEqual(visibleText(messages), [
      { hidden: false, text: MIC_DENIED_MESSAGE },
      { hidden: false, text: MIC_DENIED_MESSAGE },
    ])
    assert.equal(recMessageAfter(MIC_DENIED_MESSAGE, 'dismiss'), '')
    dom.clicks[0]({ target: messages[0].button })
    assert.deepEqual(visibleText(messages), [
      { hidden: true, text: '' },
      { hidden: true, text: '' },
    ])
    dom.clicks[0]({ target: { closest: () => null } })
    assert.equal(messages[0].hidden, true)
  } finally {
    dom.restore()
  }
})

test('a started recording clears the message, and a saved take clears only a save error', () => {
  const messages = [messageElement()]
  const dom = installDocument(messages)
  try {
    const view = viewWith()
    view.showRecMessage(MIC_FAILED_MESSAGE)
    view.noteRecordingStarted()
    assert.equal(messages[0].hidden, true)
    assert.equal(messages[0].text.textContent, '')

    for (const message of [QUOTA_TAKE_MESSAGE, SAVE_TAKE_MESSAGE, DISK_TAKE_MESSAGE]) {
      view.showRecMessage(message)
      assert.equal(messages[0].hidden, false)
      view.noteTakeSaved()
      assert.equal(messages[0].hidden, true)
      assert.equal(messages[0].text.textContent, '')
    }

    view.showRecMessage(DEVICE_LOST_MESSAGE)
    view.noteTakeSaved()
    assert.equal(messages[0].hidden, false)
    assert.equal(messages[0].text.textContent, DEVICE_LOST_MESSAGE)
    view.showRecMessage(NO_MIC_MESSAGE)
    view.noteTakeSaved()
    assert.equal(messages[0].text.textContent, NO_MIC_MESSAGE)
  } finally {
    dom.restore()
  }
})

test('an open microphone clears a failed open and leaves other notes', () => {
  assert.equal(recMessageAfter(MIC_DENIED_MESSAGE, 'mic-ready'), '')
  assert.equal(recMessageAfter(NO_MIC_MESSAGE, 'mic-ready'), '')
  assert.equal(recMessageAfter(MIC_UNOPENABLE_MESSAGE, 'mic-ready'), '')
  assert.equal(recMessageAfter(START_RECORDING_MESSAGE, 'mic-ready'), '')
  assert.equal(recMessageAfter(SAVE_TAKE_MESSAGE, 'mic-ready'), SAVE_TAKE_MESSAGE)
  assert.equal(recMessageAfter(MIC_FAILED_MESSAGE, 'mic-ready'), MIC_FAILED_MESSAGE)
  assert.equal(recMessageAfter(DEVICE_LOST_MESSAGE, 'mic-ready'), DEVICE_LOST_MESSAGE)

  const messages = [messageElement()]
  const dom = installDocument(messages)
  try {
    const view = viewWith()
    view.showRecMessage(MIC_DENIED_MESSAGE)
    view.noteMicReady()
    assert.equal(messages[0].hidden, true)
    assert.equal(messages[0].text.textContent, '')
    view.showRecMessage(SAVE_TAKE_MESSAGE)
    view.noteMicReady()
    assert.equal(messages[0].text.textContent, SAVE_TAKE_MESSAGE)
    const html = view.recorderPanelHtml()
    assert.equal(html.includes('Voice enhance'), false)
    assert.equal(html.includes('voice-enhance'), false)
  } finally {
    dom.restore()
  }
})

test('a returning microphone clears a device-lost or no-mic message only', () => {
  const messages = [messageElement(), messageElement()]
  const dom = installDocument(messages)
  try {
    const view = viewWith()
    view.showRecMessage(DEVICE_LOST_MESSAGE)
    view.noteDeviceReturned()
    assert.deepEqual(visibleText(messages), [
      { hidden: true, text: '' },
      { hidden: true, text: '' },
    ])

    view.showRecMessage(NO_MIC_MESSAGE)
    view.noteDeviceReturned()
    assert.equal(messages[0].hidden, true)

    for (const message of [MIC_DENIED_MESSAGE, MIC_FAILED_MESSAGE, MIC_UNOPENABLE_MESSAGE, START_RECORDING_MESSAGE, SAVE_TAKE_MESSAGE]) {
      view.showRecMessage(message)
      view.noteDeviceReturned()
      assert.equal(messages[0].hidden, false)
      assert.equal(messages[0].text.textContent, message)
      assert.equal(messages[1].text.textContent, message)
    }
  } finally {
    dom.restore()
  }
})

test('devices-changed clears a lost microphone once a device is listed again', async () => {
  const messages = [messageElement()]
  const dom = installDocument(messages)
  const previousStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem() {
      return null
    },
    setItem() {},
    removeItem() {},
  }
  let listed = []
  const listeners = new Map()
  try {
    const view = viewWith()
    const mic = createMicrophoneController({
      getCapture: () => ({ phase: 'idle' }),
      getPanelMode: () => 'closed',
      nativeDevices: {
        list: () => Promise.resolve(listed),
        listen(name, handler) {
          const handlers = listeners.get(name) || []
          handlers.push(handler)
          listeners.set(name, handlers)
          return Promise.resolve(() => {})
        },
      },
      onInputDeviceFound: () => view.noteDeviceReturned(),
    })
    view.showRecMessage(DEVICE_LOST_MESSAGE)
    await mic.watchNativeDevices()
    assert.equal(messages[0].hidden, false)
    assert.equal(messages[0].text.textContent, DEVICE_LOST_MESSAGE)

    for (const handler of listeners.get('recorder://devices-changed')) handler({ payload: { devices: [] } })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(messages[0].text.textContent, DEVICE_LOST_MESSAGE)

    listed = [{ id: 'wasapi:{usb}', name: 'USB mic', isDefault: true }]
    for (const handler of listeners.get('recorder://devices-changed')) handler({ payload: { devices: listed } })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(messages[0].hidden, true)
    assert.equal(messages[0].text.textContent, '')

    view.showRecMessage(MIC_DENIED_MESSAGE)
    for (const handler of listeners.get('recorder://devices-changed')) handler({ payload: { devices: listed } })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(messages[0].text.textContent, MIC_DENIED_MESSAGE)
  } finally {
    globalThis.localStorage = previousStorage
    dom.restore()
  }
})

test('devicechange clears a missing microphone once enumerateDevices finds one', async () => {
  const messages = [messageElement()]
  const dom = installDocument(messages)
  const previousStorage = globalThis.localStorage
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  globalThis.localStorage = {
    getItem() {
      return null
    },
    setItem() {},
    removeItem() {},
  }
  let devices = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: () => Promise.resolve(devices),
      },
    },
  })
  try {
    const view = viewWith()
    const mic = createMicrophoneController({
      getCapture: () => ({ phase: 'idle' }),
      getPanelMode: () => 'closed',
      onInputDeviceFound: () => view.noteDeviceReturned(),
    })
    view.showRecMessage(NO_MIC_MESSAGE)
    await mic.refreshAudioInputs()
    assert.equal(messages[0].text.textContent, NO_MIC_MESSAGE)

    devices = [{ kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' }]
    await mic.refreshAudioInputs()
    assert.equal(messages[0].text.textContent, NO_MIC_MESSAGE)

    devices = [{ kind: 'audioinput', deviceId: '', label: '' }]
    await mic.refreshAudioInputs()
    assert.equal(messages[0].hidden, true)
    assert.equal(messages[0].text.textContent, '')

    view.showRecMessage(SAVE_TAKE_MESSAGE)
    await mic.refreshAudioInputs()
    assert.equal(messages[0].text.textContent, SAVE_TAKE_MESSAGE)
  } finally {
    globalThis.localStorage = previousStorage
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
    else delete globalThis.navigator
    dom.restore()
  }
})
