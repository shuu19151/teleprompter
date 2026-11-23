import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LEADING_SIGNAL_TIMEOUT_MS,
  createCapture,
  hasNonZeroSample,
  leadingSignalDecision,
  micAudioConstraints,
} from '../src/recording/recording.js'

test('leading silence waits for a non-zero sample, then for at most 1.5s', () => {
  assert.equal(LEADING_SIGNAL_TIMEOUT_MS, 1500)
  assert.equal(hasNonZeroSample(null), false)
  assert.equal(hasNonZeroSample([]), false)
  assert.equal(hasNonZeroSample([0, 0, 0]), false)
  assert.equal(hasNonZeroSample([0, -0, 0]), false)
  assert.equal(hasNonZeroSample([0, 0.0001, 0]), true)
  assert.equal(leadingSignalDecision([0, 0, 0], 0), 'wait')
  assert.equal(leadingSignalDecision([0, 0], 1499), 'wait')
  assert.equal(leadingSignalDecision([0, -0], LEADING_SIGNAL_TIMEOUT_MS), 'start')
  assert.equal(leadingSignalDecision([0, 0], 2000), 'start')
  assert.equal(leadingSignalDecision([0, 0.2, 0], 0), 'start')
  assert.equal(leadingSignalDecision(new Float32Array([0, 0, -0.5]), 10), 'start')
})

test('microphone constraints leave the browser voice processors off', () => {
  const audio = micAudioConstraints('mic-a')
  assert.equal(audio.noiseSuppression, false)
  assert.equal(audio.echoCancellation, false)
  assert.equal(audio.autoGainControl, false)
  assert.deepEqual(audio.deviceId, { exact: 'mic-a' })
  assert.equal(micAudioConstraints('').deviceId, undefined)
})

function audioParam(value = 0) {
  return { value }
}

function installMedia() {
  const opens = []
  const constraintsSeen = []
  const recorders = []
  const made = { filters: [], compressors: [], gains: [] }
  let reads = 0
  let signalAt = 1
  let hold = null
  let trackSeq = 0

  class FakeTrack {
    constructor() {
      this.id = ++trackSeq
      this.readyState = 'live'
    }
    stop() {
      this.readyState = 'ended'
    }
    addEventListener() {}
  }

  class FakeStream {
    constructor() {
      this.tracks = [new FakeTrack()]
    }
    getTracks() {
      return this.tracks
    }
  }

  class FakeNode {
    constructor() {
      this.frequency = audioParam()
      this.Q = audioParam()
      this.gain = audioParam(1)
      this.threshold = audioParam()
      this.knee = audioParam()
      this.ratio = audioParam()
      this.attack = audioParam()
      this.release = audioParam()
      this.type = ''
      this.fftSize = 2048
      this.smoothingTimeConstant = 0
    }
    connect() {
      return this
    }
    disconnect() {}
    getFloatTimeDomainData(buf) {
      reads += 1
      buf.fill(0)
      if (reads >= signalAt) buf[0] = 0.4
    }
  }

  class FakeCtx {
    constructor() {
      this.state = 'running'
      this.destination = new FakeNode()
      this.sampleRate = 48000
    }
    createMediaStreamSource() {
      return new FakeNode()
    }
    createBiquadFilter() {
      const node = new FakeNode()
      made.filters.push(node)
      return node
    }
    createDynamicsCompressor() {
      const node = new FakeNode()
      made.compressors.push(node)
      return node
    }
    createGain() {
      const node = new FakeNode()
      made.gains.push(node)
      return node
    }
    createAnalyser() {
      return new FakeNode()
    }
    createMediaStreamDestination() {
      return { stream: new FakeStream(), connect() {}, disconnect() {} }
    }
    resume() {
      this.state = 'running'
      return Promise.resolve()
    }
    close() {
      this.state = 'closed'
      return Promise.resolve()
    }
  }

  class FakeRecorder {
    constructor(stream, options) {
      this.stream = stream
      this.state = 'inactive'
      this.mimeType = options?.mimeType || 'audio/webm'
      this.listeners = new Map()
      this.startReads = null
      recorders.push(this)
    }
    addEventListener(name, fn) {
      const list = this.listeners.get(name) || []
      list.push(fn)
      this.listeners.set(name, list)
    }
    emit(name, event) {
      for (const fn of this.listeners.get(name) || []) fn(event)
    }
    start() {
      this.state = 'recording'
      this.startReads = reads
    }
    stop() {
      if (this.state === 'inactive') return
      this.state = 'inactive'
      const data = new Blob([Uint8Array.from([1, 2, 3, 4])], { type: this.mimeType })
      this.emit('dataavailable', { data })
      this.emit('stop')
    }
    pause() {
      this.state = 'paused'
    }
    resume() {
      this.state = 'recording'
    }
    static isTypeSupported(type) {
      return String(type).includes('webm')
    }
  }

  const previousWindow = globalThis.window
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const previousRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder')
  globalThis.window = globalThis
  globalThis.AudioContext = FakeCtx
  globalThis.MediaRecorder = FakeRecorder
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia(constraints) {
          constraintsSeen.push(constraints)
          const stream = new FakeStream()
          opens.push(stream)
          if (hold) await hold
          return stream
        },
      },
    },
  })

  return {
    opens,
    constraintsSeen,
    recorders,
    made,
    get reads() {
      return reads
    },
    set signalAt(value) {
      signalAt = value
    },
    holdWith(promise) {
      hold = promise
    },
    restore() {
      if (previousWindow === undefined) delete globalThis.window
      else globalThis.window = previousWindow
      delete globalThis.AudioContext
      if (previousRecorder) Object.defineProperty(globalThis, 'MediaRecorder', previousRecorder)
      else delete globalThis.MediaRecorder
      if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
      else delete globalThis.navigator
    },
  }
}

test('voice enhance is built even when asked off, and recording waits for a sample', async () => {
  const media = installMedia()
  try {
    media.signalAt = 3
    const capture = createCapture()
    const started = await capture.start(
      {
        ...micAudioConstraints('mic-a'),
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
      { voiceEnhance: false, deviceId: 'mic-a' },
    )
    assert.equal(started.started, true)
    assert.equal(capture.phase, 'recording')
    assert.equal(media.opens.length, 1)
    assert.equal(media.constraintsSeen[0].audio.noiseSuppression, false)
    assert.equal(media.constraintsSeen[0].audio.echoCancellation, false)
    assert.equal(media.constraintsSeen[0].audio.autoGainControl, false)
    assert.deepEqual(media.constraintsSeen[0].audio.deviceId, { exact: 'mic-a' })
    assert.equal(media.made.filters.length, 1)
    assert.equal(media.made.filters[0].type, 'highpass')
    assert.equal(media.made.filters[0].frequency.value, 90)
    assert.equal(media.made.filters[0].Q.value, 0.707)
    assert.equal(media.made.compressors.length, 2)
    assert.equal(media.made.compressors[0].threshold.value, -24)
    assert.equal(media.made.compressors[0].knee.value, 12)
    assert.equal(media.made.compressors[0].ratio.value, 3)
    assert.equal(media.made.compressors[0].attack.value, 0.005)
    assert.equal(media.made.compressors[0].release.value, 0.2)
    assert.equal(media.made.gains[0].gain.value, 10 ** (2.2 / 20))
    assert.equal(media.made.compressors[1].threshold.value, -2)
    assert.equal(media.made.compressors[1].knee.value, 0)
    assert.equal(media.made.compressors[1].ratio.value, 20)
    assert.equal(media.made.compressors[1].attack.value, 0.001)
    assert.equal(media.made.compressors[1].release.value, 0.05)
    assert.equal(media.recorders.length, 1)
    assert.equal(media.recorders[0].startReads, 3)
    assert.equal(media.opens[0].getTracks()[0].readyState, 'live')

    const result = await capture.stop()
    assert.equal(capture.phase, 'idle')
    assert.ok(result?.blob?.size > 0)
    assert.equal(media.opens[0].getTracks()[0].readyState, 'live')
    assert.equal(capture.releasePrepared(), true)
    assert.equal(media.opens[0].getTracks()[0].readyState, 'ended')
  } finally {
    media.restore()
  }
})

test('a warmed microphone is reused, replaced on device change, and dropped if released mid-open', async () => {
  const media = installMedia()
  try {
    const capture = createCapture()
    const first = await capture.prepare(micAudioConstraints('mic-a'), { voiceEnhance: true, deviceId: 'mic-a' })
    assert.equal(first.prepared, true)
    assert.equal(first.reused, false)
    assert.equal(media.opens.length, 1)
    const again = await capture.prepare(micAudioConstraints('mic-a'), { deviceId: 'mic-a' })
    assert.equal(again.reused, true)
    assert.equal(media.opens.length, 1)

    const changed = await capture.prepare(micAudioConstraints('mic-b'), { deviceId: 'mic-b' })
    assert.equal(changed.prepared, true)
    assert.equal(media.opens.length, 2)
    assert.equal(media.opens[0].getTracks()[0].readyState, 'ended')
    assert.equal(media.opens[1].getTracks()[0].readyState, 'live')

    media.signalAt = 1
    const started = await capture.start(micAudioConstraints('mic-b'), { deviceId: 'mic-b' })
    assert.equal(started.started, true)
    assert.equal(media.opens.length, 2)
    await capture.stop()
    assert.equal(media.opens[1].getTracks()[0].readyState, 'live')

    let releaseHold
    const gate = new Promise((resolve) => {
      releaseHold = resolve
    })
    media.holdWith(gate)
    const pending = capture.prepare(micAudioConstraints('mic-c'), { deviceId: 'mic-c' })
    await Promise.resolve()
    assert.equal(capture.releasePrepared(), true)
    releaseHold()
    const late = await pending
    assert.equal(late.stale, true)
    assert.equal(late.prepared, false)
    assert.equal(media.opens.at(-1).getTracks()[0].readyState, 'ended')
    assert.equal(capture.phase, 'idle')
  } finally {
    media.restore()
  }
})
