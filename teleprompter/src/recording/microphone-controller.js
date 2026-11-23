/**
 * Microphone choice, the getUserMedia start, and the analyser graph.
 * The waveform reads the analyser this module exposes and does not own it.
 */
import { micAudioConstraints } from './recording.js'
import { micControlState } from './recorder-math.js'

const MIC_KEY = 'teleprompter:micId'
const VOICE_KEY = 'teleprompter:voiceEnhance'

export function isMissingMicError(error) {
  const name = error?.name || ''
  return name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'DevicesNotFoundError'
}

/** Devices for the menu. Unlabeled results stay empty so the menu can say Default. */
export function listedAudioInputs(devices) {
  const inputs = devices.filter((device) => device.kind === 'audioinput')
  const labeled = inputs.some((device) => device.label)
  if (!labeled) return { labeled: false, inputs: [] }
  const seen = new Set()
  const listed = []
  for (const device of inputs) {
    if (!device.deviceId || seen.has(device.deviceId)) continue
    seen.add(device.deviceId)
    listed.push({ deviceId: device.deviceId, label: device.label.trim() || 'Microphone' })
  }
  return { labeled: true, inputs: listed }
}

function readStorage(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore quota or private mode */
  }
}

function loadJSON(key) {
  try {
    const raw = readStorage(key)
    if (raw === null) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function createMicrophoneController({ getCapture, getPanelMode }) {
  let audioCtx = null
  let analyser = null
  let waveSource = null
  let waveMute = null
  let micId = loadMicId()
  let voiceEnhance = loadVoiceEnhance()
  let audioInputs = []
  let micListToken = 0

  function loadMicId() {
    try {
      const value = localStorage.getItem(MIC_KEY)
      return typeof value === 'string' ? value : ''
    } catch {
      return ''
    }
  }

  function loadVoiceEnhance() {
    const saved = loadJSON(VOICE_KEY)
    if (typeof saved === 'boolean') return saved
    return true
  }

  function saveMicId(id) {
    micId = id || ''
    try {
      if (micId) localStorage.setItem(MIC_KEY, micId)
      else localStorage.removeItem(MIC_KEY)
    } catch {
      /* ignore quota or private mode */
    }
  }

  function closeAudioGraph() {
    try {
      waveSource?.disconnect()
    } catch {
      /* already disconnected */
    }
    try {
      analyser?.disconnect()
    } catch {
      /* already disconnected */
    }
    try {
      waveMute?.disconnect()
    } catch {
      /* already disconnected */
    }
    waveSource = null
    analyser = null
    waveMute = null
    const ctx = audioCtx
    audioCtx = null
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {})
  }

  function ensureAudioContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    if (!audioCtx || audioCtx.state === 'closed') {
      try {
        audioCtx = new Ctx({ sampleRate: 48000 })
      } catch {
        audioCtx = new Ctx()
      }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
    return audioCtx
  }

  function attachAnalyser(stream) {
    const ctx = ensureAudioContext()
    if (!ctx || !stream) return
    try {
      waveSource?.disconnect()
    } catch {
      /* ignore */
    }
    analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.2
    waveSource = ctx.createMediaStreamSource(stream)
    waveSource.connect(analyser)
    // A silent tap keeps the analyser pulling samples. Nothing is heard.
    waveMute = ctx.createGain()
    waveMute.gain.value = 0
    analyser.connect(waveMute)
    waveMute.connect(ctx.destination)
  }

  function resumeIfSuspended() {
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {})
  }

  function syncMicControls() {
    const row = document.querySelector('#mic-row')
    const controls = micControlState({ mode: getPanelMode(), phase: getCapture().phase })
    if (row) row.hidden = controls.panelOpen
    for (const select of document.querySelectorAll('select.mic-select')) select.disabled = controls.busy
    for (const input of document.querySelectorAll('input.voice-enhance-input')) input.disabled = controls.busy
  }

  function micOptions() {
    if (!audioInputs.length) return [{ deviceId: '', label: 'Default microphone' }]
    return audioInputs
  }

  function renderMicSelects() {
    const options = micOptions()
    const signature = options.map((option) => `${option.deviceId}\t${option.label}`).join('\n')
    const known = options.some((option) => option.deviceId === micId)
    const desired = known ? micId : options[0]?.deviceId || ''
    for (const select of document.querySelectorAll('select.mic-select')) {
      if (select.dataset.options !== signature) {
        select.replaceChildren(
          ...options.map((option) => {
            const el = document.createElement('option')
            el.value = option.deviceId
            el.textContent = option.label
            return el
          }),
        )
        select.dataset.options = signature
      }
      if (select.value !== desired) select.value = desired
    }
    syncMicControls()
  }

  async function refreshAudioInputs() {
    const token = ++micListToken
    let devices = []
    try {
      devices = (await navigator.mediaDevices?.enumerateDevices?.()) || []
    } catch {
      devices = []
    }
    if (token !== micListToken) return
    const listed = listedAudioInputs(devices)
    audioInputs = listed.inputs
    if (listed.labeled && micId && !audioInputs.some((device) => device.deviceId === micId)) saveMicId('')
    renderMicSelects()
  }

  function onMicChange(event) {
    const value = event.target.value || ''
    if (value === micId) {
      renderMicSelects()
      return
    }
    saveMicId(value)
    renderMicSelects()
  }

  function chosenMicId() {
    if (!micId) return ''
    if (audioInputs.length && !audioInputs.some((device) => device.deviceId === micId)) return ''
    return micId
  }

  function syncVoiceEnhanceInputs() {
    for (const input of document.querySelectorAll('input.voice-enhance-input')) input.checked = voiceEnhance
  }

  function onVoiceEnhanceChange(event) {
    voiceEnhance = Boolean(event.target.checked)
    writeStorage(VOICE_KEY, JSON.stringify(voiceEnhance))
    syncVoiceEnhanceInputs()
  }

  async function openCapture() {
    const capture = getCapture()
    const deviceId = chosenMicId()
    const enhance = voiceEnhance
    try {
      return await capture.start(micAudioConstraints(deviceId), { voiceEnhance: enhance })
    } catch (error) {
      if (deviceId && isMissingMicError(error)) {
        saveMicId('')
        renderMicSelects()
        return capture.start(micAudioConstraints(''), { voiceEnhance: enhance })
      }
      throw error
    }
  }

  return {
    getAnalyser() {
      return analyser
    },
    isVoiceEnhance() {
      return voiceEnhance
    },
    closeAudioGraph,
    ensureAudioContext,
    attachAnalyser,
    resumeIfSuspended,
    syncMicControls,
    renderMicSelects,
    refreshAudioInputs,
    onMicChange,
    onVoiceEnhanceChange,
    openCapture,
  }
}
