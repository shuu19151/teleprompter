/**
 * Microphone choice, the getUserMedia start, and the analyser graph.
 * The waveform reads the analyser this module exposes and does not own it.
 */
import { DEVICE_LOST_MESSAGE, describeMediaError } from './rec-messages.js'
import { micAudioConstraints } from './recording.js'
import { micControlState } from './recorder-math.js'

export { DEVICE_LOST_MESSAGE }

const MIC_KEY = 'teleprompter:micId'

/** Strip noisy Android suffixes and collapse whitespace. */
function cleanMicLabel(raw) {
  const cleaned = String(raw || '')
    .replace(/\s*\((?:Microphone|Tuner|Virtual|Default|Built-in)\)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'Microphone'
}

/** When several devices share a label, append " · 2", " · 3", … */
function dedupeMicLabels(list) {
  const counts = new Map()
  for (const item of list) {
    counts.set(item.label, (counts.get(item.label) || 0) + 1)
  }
  const seen = new Map()
  return list.map((item) => {
    if ((counts.get(item.label) || 0) < 2) return item
    const n = (seen.get(item.label) || 0) + 1
    seen.set(item.label, n)
    return { ...item, label: `${item.label} · ${n}` }
  })
}

function labelNativeMics(list) {
  const counts = new Map()
  for (const item of list) counts.set(item.label, (counts.get(item.label) || 0) + 1)
  const seen = new Map()
  return list.map((item) => {
    if ((counts.get(item.label) || 0) < 2) return item
    const number = (seen.get(item.label) || 0) + 1
    seen.set(item.label, number)
    return {
      ...item,
      label: item.isDefault ? 'Default microphone' : `Microphone ${number}`,
    }
  })
}

function captureCapableNativeDevices(devices) {
  const typed = devices.filter((device) => /\((?:Microphone|Tuner|Virtual)\)\s*$/i.test(String(device?.name || '')))
  if (!typed.length) return devices
  return typed.filter((device) => /\(Microphone\)\s*$/i.test(String(device?.name || '')))
}

/** Native devices, default first, in the shape the existing menu already renders. */
export function nativeMicOptions(devices) {
  const rows = captureCapableNativeDevices(Array.isArray(devices) ? devices : [])
  const ordered = [
    ...rows.filter((device) => device && device.isDefault),
    ...rows.filter((device) => device && !device.isDefault),
  ]
  const seen = new Set()
  const listed = []
  for (const device of ordered) {
    const deviceId = typeof device?.id === 'string' ? device.id : ''
    if (!deviceId || seen.has(deviceId)) continue
    seen.add(deviceId)
    const label = cleanMicLabel(device.name)
    listed.push({ deviceId, label, isDefault: Boolean(device.isDefault) })
  }
  return labelNativeMics(listed).map(({ deviceId, label }) => ({ deviceId, label }))
}

export function nativeMicRoutes(inputs) {
  const rows = Array.isArray(inputs) ? inputs : []
  const phone = rows.find((input) => /^(?:Default microphone|Microphone \d+)$/i.test(input.label)) || rows[0]
  if (!phone?.deviceId) return []
  const external = rows.filter((input) => input.deviceId !== phone.deviceId && !/^Microphone \d+$/i.test(input.label))
  const preferred = external[0] || phone
  return [
    { deviceId: 'native:auto', captureDeviceId: preferred.deviceId, label: 'Automatic (recommended)' },
    { deviceId: 'native:phone', captureDeviceId: phone.deviceId, label: 'Phone microphone' },
    ...external.map((input, index) => ({
      deviceId: `native:external:${index}`,
      captureDeviceId: input.deviceId,
      label: `External microphone · ${input.label}`,
    })),
  ]
}

export function applyDeviceLost({ active, finish, showRecMessage }) {
  showRecMessage?.(DEVICE_LOST_MESSAGE)
  if (active) return finish?.({ openAfter: false })
  return undefined
}

/** True when the web device list or the native device list contains an input. */
export function foundInputDevice(devices, { native = false } = {}) {
  const rows = Array.isArray(devices) ? devices : []
  if (native) return nativeMicOptions(rows).length > 0
  return rows.some((device) => device?.kind === 'audioinput')
}

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
    listed.push({ deviceId: device.deviceId, label: cleanMicLabel(device.label) })
  }
  return { labeled: true, inputs: dedupeMicLabels(listed) }
}

function pageIsVisible() {
  try {
    return document.visibilityState !== 'hidden'
  } catch {
    return true
  }
}

export function createMicrophoneController({
  getCapture,
  getPanelMode,
  nativeDevices = null,
  onDeviceLost,
  onInputDeviceFound,
  showRecMessage,
  onMicReady,
  stopIfActive,
} = {}) {
  let audioCtx = null
  let analyser = null
  let waveSource = null
  let waveMute = null
  let micId = loadMicId()
  let audioInputs = []
  let micListToken = 0
  let nativeWatching = false
  let readerOpen = false
  let wantOpen = pageIsVisible()
  let generation = 0
  let pickerReturnFocus = null
  let pickerHistoryOpen = false

  function loadMicId() {
    try {
      const value = localStorage.getItem(MIC_KEY)
      return typeof value === 'string' ? value : ''
    } catch {
      return ''
    }
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
    for (const trigger of micControls()) trigger.disabled = controls.busy
  }

  function micControls() {
    return [
      ...document.querySelectorAll('button.mic-select'),
      ...document.querySelectorAll('select.mic-select'),
    ]
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
    for (const trigger of micControls()) {
      trigger.dataset.options = signature
      if (typeof trigger.replaceChildren === 'function' && !trigger.querySelector) {
        trigger.replaceChildren(
          ...options.map((option) => {
            const el = document.createElement('option')
            el.value = option.deviceId
            el.textContent = option.label
            return el
          }),
        )
        trigger.value = desired
      } else {
        trigger.dataset.value = desired
        const label = trigger.querySelector?.('.mic-select-label')
        if (label) label.textContent = options.find((option) => option.deviceId === desired)?.label || 'Default microphone'
      }
    }
    renderMicPicker()
    syncMicControls()
  }

  function pickerMarkup() {
    return `<div class="mic-picker" id="mic-picker" hidden>
      <button class="mic-picker-backdrop" type="button" data-mic-close aria-label="Close microphone picker"></button>
      <section class="mic-picker-sheet" role="dialog" aria-modal="true" aria-labelledby="mic-picker-title">
        <div class="mic-picker-head">
          <div><h2 id="mic-picker-title">Microphone</h2><p>Recording source</p></div>
          <button class="mic-picker-close" type="button" data-mic-close aria-label="Close">&times;</button>
        </div>
        <div class="mic-picker-options" role="radiogroup" aria-label="Microphone source"></div>
      </section>
    </div>`
  }

  function ensureMicPicker() {
    let picker = document.querySelector('#mic-picker')
    if (picker) return picker
    document.body.insertAdjacentHTML('beforeend', pickerMarkup())
    picker = document.querySelector('#mic-picker')
    picker.addEventListener('click', (event) => {
      const close = event.target.closest('[data-mic-close]')
      if (close) return closeMicPicker()
      const option = event.target.closest('[data-mic-value]')
      if (!option) return
      chooseMic(option.dataset.micValue || '')
      closeMicPicker()
    })
    picker.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMicPicker()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...picker.querySelectorAll('button:not([disabled])')]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    })
    window.addEventListener('popstate', () => {
      if (picker.hidden) return
      pickerHistoryOpen = false
      closeMicPicker({ fromHistory: true })
    })
    return picker
  }

  function renderMicPicker() {
    const picker = document.querySelector('#mic-picker')
    if (!picker) return
    const options = micOptions()
    const known = options.some((option) => option.deviceId === micId)
    const desired = known ? micId : options[0]?.deviceId || ''
    const host = picker.querySelector('.mic-picker-options')
    host.innerHTML = options
      .map((option) => {
        const selected = option.deviceId === desired
        const automatic = option.deviceId === 'native:auto'
        const phone = option.deviceId === 'native:phone'
        const description = automatic
          ? 'Prefers an external mic, then uses the phone'
          : phone
            ? 'Built-in microphone'
            : option.deviceId.startsWith('native:external:')
              ? 'USB, wired, or Bluetooth microphone'
              : 'Available recording input'
        return `<button class="mic-picker-option${selected ? ' is-selected' : ''}" type="button" role="radio" aria-checked="${selected}" data-mic-value="${escapeAttribute(option.deviceId)}">
          <span class="mic-picker-copy"><strong>${escapeText(option.label)}</strong><small>${description}</small></span>
          <span class="mic-picker-radio" aria-hidden="true"></span>
        </button>`
      })
      .join('')
  }

  function escapeText(value) {
    const span = document.createElement('span')
    span.textContent = String(value || '')
    return span.innerHTML
  }

  function escapeAttribute(value) {
    return escapeText(value).replace(/"/g, '&quot;')
  }

  function openMicPicker(trigger) {
    if (trigger.disabled) return
    pickerReturnFocus = trigger
    const picker = ensureMicPicker()
    renderMicPicker()
    picker.hidden = false
    document.documentElement.classList.add('has-modal')
    try {
      window.history.pushState({ micPicker: true }, '')
      pickerHistoryOpen = true
    } catch {
      pickerHistoryOpen = false
    }
    picker.querySelector('[aria-checked="true"]')?.focus()
  }

  function closeMicPicker({ fromHistory = false } = {}) {
    const picker = document.querySelector('#mic-picker')
    if (!picker || picker.hidden) return
    picker.hidden = true
    document.documentElement.classList.remove('has-modal')
    if (pickerHistoryOpen && !fromHistory) {
      pickerHistoryOpen = false
      window.history.back()
    }
    pickerReturnFocus?.focus()
    pickerReturnFocus = null
  }

  function chooseMic(value) {
    if (value === micId) return renderMicSelects()
    saveMicId(value)
    renderMicSelects()
    if (readerOpen && wantOpen) {
      const token = ++generation
      void acquire(token)
    }
  }

  function bindMicPicker() {
    ensureMicPicker()
    for (const trigger of document.querySelectorAll('button.mic-select')) {
      if (trigger.dataset.micBound) continue
      trigger.dataset.micBound = 'true'
      trigger.addEventListener('click', () => openMicPicker(trigger))
    }
  }

  async function refreshNativeInputs() {
    const token = ++micListToken
    let devices = []
    try {
      devices = (await nativeDevices.list()) || []
    } catch {
      devices = []
    }
    if (token !== micListToken) return
    const inputs = nativeMicOptions(devices)
    const hasAndroidRoutes = devices.some((device) => /\((?:Microphone|Tuner|Virtual)\)\s*$/i.test(String(device?.name || '')))
    audioInputs = hasAndroidRoutes ? nativeMicRoutes(inputs) : inputs
    if (!audioInputs.some((device) => device.deviceId === micId)) {
      saveMicId(audioInputs[0]?.deviceId || '')
    }
    renderMicSelects()
    if (foundInputDevice(devices, { native: true })) onInputDeviceFound?.()
  }

  async function watchNativeDevices() {
    if (!nativeDevices || nativeWatching) return
    nativeWatching = true
    try {
      await nativeDevices.listen('recorder://devices-changed', () => {
        void refreshNativeInputs()
      })
      await nativeDevices.listen('recorder://device-lost', (event) => {
        onDeviceLost?.(event?.payload)
      })
    } catch {
      nativeWatching = false
    }
    await refreshNativeInputs()
  }

  async function refreshAudioInputs() {
    if (nativeDevices) {
      await refreshNativeInputs()
      return
    }
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
    if (foundInputDevice(devices)) onInputDeviceFound?.()
  }

  function onMicChange(event) {
    chooseMic(event.target.value || event.target.dataset?.value || '')
  }

  function chosenMicId() {
    if (!micId) return ''
    const selected = audioInputs.find((device) => device.deviceId === micId)
    if (audioInputs.length && !selected) return ''
    return selected?.captureDeviceId || micId
  }

  async function openPrepared(deviceId) {
    const capture = getCapture()
    try {
      return await capture.prepare(micAudioConstraints(deviceId), { voiceEnhance: true, deviceId })
    } catch (error) {
      if (!(deviceId && isMissingMicError(error))) throw error
      saveMicId('')
      renderMicSelects()
      return capture.prepare(micAudioConstraints(''), { voiceEnhance: true, deviceId: '' })
    }
  }

  function canWarm(capture) {
    return !!capture && capture.usesWebCapture !== false && typeof capture.prepare === 'function'
  }

  async function acquire(token) {
    const capture = getCapture()
    if (!canWarm(capture)) return
    if (!readerOpen || !wantOpen) return
    if (capture.isActive?.()) return
    const deviceId = chosenMicId()
    try {
      const result = await openPrepared(deviceId)
      if (token !== generation || !readerOpen || !wantOpen) return
      if (!result?.prepared) return
      onMicReady?.()
    } catch (error) {
      if (token !== generation || !readerOpen || !wantOpen) return
      showRecMessage?.(describeMediaError(error))
    }
  }

  async function releaseAfterIdle(token) {
    const capture = getCapture()
    if (capture?.isActive?.()) {
      try {
        await stopIfActive?.()
      } catch {
        /* stop reports its own failure */
      }
    }
    if (token !== generation) return
    const current = getCapture()
    if (current?.phase === 'recording' || current?.phase === 'paused' || current?.phase === 'stopping') return
    try {
      current?.releasePrepared?.()
    } catch {
      /* already released */
    }
  }

  function refreshWarm() {
    const token = ++generation
    if (readerOpen && wantOpen) void acquire(token)
    else void releaseAfterIdle(token)
  }

  function noteReaderOpen(open) {
    readerOpen = !!open
    refreshWarm()
  }

  function notePageVisibility(visible) {
    wantOpen = !!visible
    refreshWarm()
  }

  async function openCapture() {
    const capture = getCapture()
    const deviceId = chosenMicId()
    try {
      return await capture.start(micAudioConstraints(deviceId), { voiceEnhance: true, deviceId })
    } catch (error) {
      if (deviceId && isMissingMicError(error)) {
        saveMicId('')
        renderMicSelects()
        return capture.start(micAudioConstraints(''), { voiceEnhance: true, deviceId: '' })
      }
      throw error
    }
  }

  return {
    getAnalyser() {
      return analyser
    },
    closeAudioGraph,
    ensureAudioContext,
    attachAnalyser,
    resumeIfSuspended,
    syncMicControls,
    renderMicSelects,
    bindMicPicker,
    refreshAudioInputs,
    watchNativeDevices,
    onMicChange,
    noteReaderOpen,
    notePageVisibility,
    openCapture,
  }
}
