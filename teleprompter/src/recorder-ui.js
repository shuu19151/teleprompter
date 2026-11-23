import {
  addTake,
  createCapture,
  describeMediaError,
  formatFine,
  isQuotaError as isIdbQuotaError,
  listTakes,
  micAudioConstraints,
  removeTake,
  sampleLevel,
  waveformPeaks,
} from './recording.js'
import {
  WAVE_STEP_MS,
  barHeight,
  chooseTakes,
  formatTakeDuration,
  formatTakeWhen,
  micControlState,
  panelChromeState,
  playbackClockText,
  playbackNowSec,
  playbackRatio,
  playbackSampleWindow,
  recControlState,
  recordingSampleWindow,
  rulerMark,
  rulerWindow,
  storedTake,
  takeDateIso,
  takeMeta as buildTakeMeta,
  takeTextKey,
  timeAtPointer,
  timelineScale,
  waveX,
} from './recorder-math.js'
import { inTauri } from './essay-folder.js'
import { elementFromEvent, openRowMenu } from './row-menu.js'
import { revealTakeFile, saveTakeToDocuments } from './take-disk.js'
import { bridge } from './ui-bridge.js'

const REC_WITH_RUN_KEY = 'teleprompter:recWithRun'
const MIC_KEY = 'teleprompter:micId'
const VOICE_KEY = 'teleprompter:voiceEnhance'
const QUOTA_TAKE_MESSAGE = 'Could not save this take because browser storage is full.'
const SAVE_TAKE_MESSAGE = 'Could not save this take.'
const DISK_TAKE_MESSAGE = 'Could not save the take to Documents.'
const DELETE_TAKE_MESSAGE = 'Could not delete this take.'
const STOP_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5" fill="currentColor"/></svg>`
const PAUSE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>`
const PLAY_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.2v13.6l11-6.8z"/></svg>`
const CLOSE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`
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

function loadRecWithRun() {
  const saved = loadJSON(REC_WITH_RUN_KEY)
  if (typeof saved === 'boolean') return saved
  return true
}

let recWithRun = loadRecWithRun()
let recordingMeta = null
let saveTask = null
let pendingCommit = null
let takesToken = 0
let panelMode = 'closed'
let manualHold = false
let micId = loadMicId()
let voiceEnhance = loadVoiceEnhance()
let audioInputs = []
let micListToken = 0
let openAfterSave = true
let audioCtx = null
let analyser = null
let waveSource = null
let waveMute = null
const PEAK_RING_SIZE = 16384
const peakRing = new Float32Array(PEAK_RING_SIZE)
let peakCount = 0
let peakLive = 0
let rulerBuilt = { key: '', have: new Set() }
let waveGen = 0
let playGen = 0
let seeking = false
let seekAnchor = null
let playback = null
let shownTakes = []
let colorCache = { theme: '', ink: '', line: '' }
const capture = createCapture({
  onError() {
    showRecMessage('Recording stopped because the microphone failed.')
    void stopRecordingAndSave()
  },
  onStopped(result) {
    pendingCommit?.(result)
  },
})

export function syncRecorderToRun() {
  if (capture.phase !== 'recording' && capture.phase !== 'paused') return
  if (!recWithRun) {
    if (!manualHold) capture.resume()
    syncRecUi()
    return
  }
  if (bridge.isRunning()) {
    manualHold = false
    capture.resume()
  } else capture.pause()
  syncRecUi()
}

function takeMeta() {
  return buildTakeMeta(bridge.current())
}

export function showRecMessage(message) {
  const text = message || ''
  for (const el of document.querySelectorAll('[data-rec-message]')) {
    el.textContent = text
    el.hidden = !text
  }
}

export function syncRecUi() {
  const view = recControlState(capture.phase)
  for (const button of document.querySelectorAll('#rec, #rec-stage')) {
    button.setAttribute('aria-pressed', view.pressed)
    button.classList.toggle('is-recording', view.recording)
    button.classList.toggle('is-paused', view.paused)
    button.setAttribute('aria-label', view.label)
  }
  if (panelMode === 'recording') syncPanelChrome()
}

function themeColors() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  if (colorCache.theme === theme && colorCache.ink) return colorCache
  const style = getComputedStyle(document.documentElement)
  colorCache = {
    theme,
    wave: style.getPropertyValue('--muted').trim() || '#6f6961',
    ink: style.getPropertyValue('--ink').trim() || '#1d1b18',
    line: style.getPropertyValue('--line-strong').trim() || '#c6bbac',
  }
  return colorCache
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

function syncMicControls() {
  const row = document.querySelector('#mic-row')
  const controls = micControlState({ mode: panelMode, phase: capture.phase })
  if (row) row.hidden = controls.panelOpen
  for (const select of document.querySelectorAll('select.mic-select')) select.disabled = controls.busy
  for (const input of document.querySelectorAll('input.voice-enhance-input')) input.disabled = controls.busy
}

function micOptions() {
  if (!audioInputs.length) return [{ deviceId: '', label: 'Default microphone' }]
  return audioInputs
}

export function renderMicSelects() {
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

export async function refreshAudioInputs() {
  const token = ++micListToken
  let inputs = []
  try {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.()) || []
    inputs = devices.filter((device) => device.kind === 'audioinput')
  } catch {
    inputs = []
  }
  if (token !== micListToken) return
  const labeled = inputs.some((device) => device.label)
  if (!labeled) audioInputs = []
  else {
    const seen = new Set()
    audioInputs = []
    for (const device of inputs) {
      if (!device.deviceId || seen.has(device.deviceId)) continue
      seen.add(device.deviceId)
      audioInputs.push({ deviceId: device.deviceId, label: device.label.trim() || 'Microphone' })
    }
    if (micId && !audioInputs.some((device) => device.deviceId === micId)) saveMicId('')
  }
  renderMicSelects()
}

export function onMicChange(event) {
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

function isMissingMicError(error) {
  const name = error?.name || ''
  return name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'DevicesNotFoundError'
}

function syncVoiceEnhanceInputs() {
  for (const input of document.querySelectorAll('input.voice-enhance-input')) input.checked = voiceEnhance
}

export function onVoiceEnhanceChange(event) {
  voiceEnhance = Boolean(event.target.checked)
  writeStorage(VOICE_KEY, JSON.stringify(voiceEnhance))
  syncVoiceEnhanceInputs()
}

async function openCapture() {
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

function resetPeaks() {
  peakCount = 0
  peakLive = 0
}

function pushPeak(level) {
  peakRing[peakCount % PEAK_RING_SIZE] = level
  peakCount += 1
}

function peakAt(index) {
  return peakRing[index % PEAK_RING_SIZE]
}

function exportPeaks() {
  const available = Math.min(peakCount, PEAK_RING_SIZE)
  const origin = peakCount - available
  const peaks = new Float32Array(available)
  for (let i = 0; i < available; i += 1) peaks[i] = peakAt(origin + i)
  return { peaks, origin }
}

export function resetRulerTrack() {
  rulerBuilt = { key: '', have: new Set() }
  const track = document.querySelector('#recorder-ruler-track')
  if (!track) return
  track.replaceChildren()
  track.style.transform = ''
}

function fitCanvas(canvas) {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width < 2 || height < 2) return null
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
  const bitmapW = Math.round(width * dpr)
  const bitmapH = Math.round(height * dpr)
  if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
    canvas.width = bitmapW
    canvas.height = bitmapH
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, width, height }
}

function addRulerMark(track, index, pxPerSec) {
  const mark = rulerMark(index, pxPerSec)
  const tick = document.createElement('span')
  tick.className = mark.major ? 'ruler-tick major' : 'ruler-tick minor'
  tick.dataset.index = String(index)
  tick.dataset.ms = String(mark.tMs)
  tick.style.left = `${mark.x}px`
  track.appendChild(tick)
  if (!mark.major) return
  const label = document.createElement('span')
  label.className = 'ruler-label'
  label.dataset.index = String(index)
  label.dataset.ms = String(mark.tMs)
  label.style.left = `${mark.x}px`
  label.textContent = formatFine(mark.tMs)
  track.appendChild(label)
}

/**
 * Slide one ruler track. Only marks inside the visible window are kept.
 * Times before 00:00.00 are never created. The waveform, not the ruler, stops at the playhead.
 */
function placeRuler(width, centerX, pxPerSec, nowSec) {
  const track = document.querySelector('#recorder-ruler-track')
  const marks = rulerWindow(width, centerX, pxPerSec, nowSec)
  if (!track || !marks) return
  const { first, last, key } = marks
  if (rulerBuilt.key !== key) {
    track.replaceChildren()
    rulerBuilt = { key, have: new Set() }
  }
  if (!rulerBuilt.have) rulerBuilt.have = new Set()
  for (const child of [...track.children]) {
    const index = Number(child.dataset.index)
    if (index < first || index > last) {
      child.remove()
      rulerBuilt.have.delete(index)
    }
  }
  for (let index = first; index <= last; index += 1) {
    if (rulerBuilt.have.has(index)) continue
    addRulerMark(track, index, pxPerSec)
    rulerBuilt.have.add(index)
  }
  track.style.width = `${marks.width}px`
  track.style.transform = `translateX(${marks.translateX}px)`
}

function drawBaseline(ctx, width, height, color) {
  const mid = height / 2
  ctx.fillStyle = color
  ctx.fillRect(0, mid - 0.5, width, 1)
}

function drawBar(ctx, x, mid, bar) {
  ctx.fillRect(Math.round(x), mid - bar / 2, 1, bar)
}

function drawRecordingWave(canvas, nowSec, centerX, pxPerSec) {
  const view = fitCanvas(canvas)
  if (!view) return
  const { ctx, width, height } = view
  const colors = themeColors()
  ctx.clearRect(0, 0, width, height)
  drawBaseline(ctx, width, height, colors.line)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, centerX, height)
  ctx.clip()
  ctx.fillStyle = colors.wave
  const mid = height / 2
  const { first, step } = recordingSampleWindow({
    peakCount,
    ringSize: PEAK_RING_SIZE,
    nowSec,
    centerX,
    pxPerSec,
  })
  for (let i = first; i < peakCount; i += 1) {
    const t = (i + 0.5) * step
    const x = waveX(centerX, t, nowSec, pxPerSec)
    if (x < -4) continue
    if (x > centerX) break
    const bar = barHeight(peakAt(i), height)
    if (bar <= 0) continue
    drawBar(ctx, x, mid, bar)
  }
  const live = barHeight(peakLive, height)
  if (live > 0) ctx.fillRect(Math.round(centerX) - 1, mid - live / 2, 1, live)
  ctx.restore()
}

function drawPlaybackWave(canvas, peaks, origin, step, nowSec, centerX, pxPerSec) {
  const view = fitCanvas(canvas)
  if (!view) return
  const { ctx, width, height } = view
  const colors = themeColors()
  ctx.clearRect(0, 0, width, height)
  drawBaseline(ctx, width, height, colors.line)
  if (!peaks?.length || !(step > 0) || !(pxPerSec > 0)) return
  ctx.fillStyle = colors.wave
  const mid = height / 2
  const { first, last } = playbackSampleWindow({
    nowSec,
    centerX,
    pxPerSec,
    width,
    step,
    origin,
    length: peaks.length,
  })
  for (let i = first; i < last; i += 1) {
    const t = (origin + i + 0.5) * step
    if (t < 0) continue
    const x = waveX(centerX, t, nowSec, pxPerSec)
    if (x < -4 || x > width + 4) continue
    const bar = barHeight(peaks[i], height)
    if (bar <= 0) continue
    drawBar(ctx, x, mid, bar)
  }
}

export function paintRecording() {
  if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {})
  const elapsed = capture.elapsedMs()
  const nowSec = Math.max(0, elapsed / 1000)
  if (capture.phase === 'recording') {
    const expected = Math.floor(elapsed / WAVE_STEP_MS)
    let guard = 0
    while (peakCount < expected && guard < 8) {
      pushPeak(sampleLevel(analyser))
      guard += 1
    }
    peakLive = sampleLevel(analyser)
  }
  const clock = document.querySelector('#recorder-clock')
  if (clock) clock.textContent = formatFine(elapsed)
  const canvas = document.querySelector('#recorder-wave')
  if (!canvas) return
  const width = canvas.clientWidth
  const { centerX, pxPerSec } = timelineScale(width)
  placeRuler(width, centerX, pxPerSec, nowSec)
  drawRecordingWave(canvas, nowSec, centerX, pxPerSec)
}

function startWaveLoop() {
  const gen = ++waveGen
  const frame = () => {
    if (gen !== waveGen || panelMode !== 'recording') return
    paintRecording()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

function stopWaveLoop() {
  waveGen += 1
}

function playbackDuration() {
  const audio = playback?.audio
  if (audio && Number.isFinite(audio.duration) && audio.duration > 0 && audio.duration !== Infinity) return audio.duration
  if (Number.isFinite(playback?.decodedDuration) && playback.decodedDuration > 0) return playback.decodedDuration
  const ms = playback?.take?.durationMs
  if (ms > 0) return ms / 1000
  return 0
}

export function paintPlayback(forcedTime) {
  if (panelMode !== 'playback' || !playback) return
  const duration = playbackDuration()
  const current = forcedTime != null ? forcedTime : playback.audio?.currentTime || 0
  const nowSec = playbackNowSec(current, duration)
  playback.ratio = playbackRatio(nowSec, duration)
  const clock = document.querySelector('#recorder-clock')
  if (clock) clock.textContent = playbackClockText(nowSec * 1000, duration * 1000)
  const canvas = document.querySelector('#recorder-wave')
  if (!canvas) return
  const width = canvas.clientWidth
  const { centerX, pxPerSec } = timelineScale(width)
  const step = playback.peakStep > 0 ? playback.peakStep : duration > 0 && playback.peaks?.length ? duration / playback.peaks.length : WAVE_STEP_MS / 1000
  placeRuler(width, centerX, pxPerSec, nowSec)
  drawPlaybackWave(canvas, playback.peaks, playback.peakOrigin || 0, step, nowSec, centerX, pxPerSec)
}

function startPlayLoop() {
  const gen = ++playGen
  const frame = () => {
    if (gen !== playGen) return
    if (!playback?.audio || playback.audio.paused || playback.audio.ended) return
    if (!seeking) paintPlayback()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

function stopPlayLoop() {
  playGen += 1
}

function syncPanelChrome() {
  const panel = document.querySelector('#recorder-panel')
  if (!panel) return
  const playbackPaused = !playback?.audio || playback.audio.paused || playback.audio.ended
  const view = panelChromeState({ mode: panelMode, phase: capture.phase, playbackPaused })
  panel.classList.toggle('is-open', view.open)
  panel.dataset.mode = view.mode
  panel.setAttribute('aria-hidden', view.hidden)
  if (view.open) panel.removeAttribute('inert')
  else panel.setAttribute('inert', '')
  const stop = panel.querySelector('#recorder-stop')
  const pause = panel.querySelector('#recorder-pause')
  const play = panel.querySelector('#recorder-play')
  const close = panel.querySelector('#recorder-close')
  if (stop) stop.hidden = view.stopHidden
  if (pause) {
    pause.hidden = view.pauseHidden
    pause.innerHTML = view.pauseShowsPlay ? PLAY_ICON : PAUSE_ICON
    pause.setAttribute('aria-label', view.pauseLabel)
    pause.setAttribute('aria-pressed', view.pausePressed)
  }
  if (play) {
    play.hidden = view.playHidden
    play.innerHTML = view.playShowsPlay ? PLAY_ICON : PAUSE_ICON
    play.setAttribute('aria-label', view.playLabel)
    play.setAttribute('aria-pressed', view.playPressed)
  }
  if (close) close.hidden = view.closeHidden
  syncMicControls()
  const canvas = panel.querySelector('#recorder-wave')
  if (canvas) canvas.setAttribute('aria-label', view.waveLabel)
}

function markActiveTake() {
  const id = panelMode === 'playback' ? playback?.take?.id : null
  for (const row of document.querySelectorAll('#takes-list [data-take-id]')) {
    const on = id != null && row.dataset.takeId === String(id)
    row.classList.toggle('is-on', on)
    const select = row.querySelector('.take-select')
    if (!select) continue
    select.setAttribute('aria-pressed', on ? 'true' : 'false')
    if (on) select.setAttribute('aria-current', 'true')
    else select.removeAttribute('aria-current')
  }
}

function releasePlayback() {
  stopPlayLoop()
  seeking = false
  seekAnchor = null
  if (playback?.audio) {
    playback.audio.pause()
    playback.audio.removeAttribute('src')
    playback.audio.load?.()
  }
  if (playback?.url) URL.revokeObjectURL(playback.url)
  playback = null
}

export function closeRecorderPanel() {
  if (panelMode === 'recording' && capture.isActive()) return
  const panel = document.querySelector('#recorder-panel')
  if (panel?.contains(document.activeElement)) document.querySelector('#rec')?.focus()
  stopWaveLoop()
  releasePlayback()
  panelMode = 'closed'
  syncPanelChrome()
  markActiveTake()
}

export function restoreRecorderPanel() {
  if (panelMode === 'recording' && capture.isActive()) {
    syncPanelChrome()
    startWaveLoop()
    return
  }
  if (panelMode === 'playback' && playback) {
    syncPanelChrome()
    paintPlayback()
    if (playback.audio && !playback.audio.paused && !playback.audio.ended) startPlayLoop()
    markActiveTake()
    return
  }
  panelMode = 'closed'
  syncPanelChrome()
}

function timeFromPointer(event, anchor) {
  const visual = document.querySelector('#recorder-visual')
  if (!visual) return 0
  const rect = visual.getBoundingClientRect()
  if (!rect.width) return 0
  const x = event.clientX - rect.left
  const centerX = rect.width / 2
  const pxPerSec = anchor?.pxPerSec || timelineScale(rect.width).pxPerSec
  const now = anchor?.now || 0
  return timeAtPointer({ x, centerX, pxPerSec, now })
}

function seekPlayback(timeSec) {
  const duration = playbackDuration()
  const audio = playback?.audio
  if (!audio || !duration) return
  const time = Math.min(duration, Math.max(0, timeSec))
  try {
    audio.currentTime = time
  } catch {
    /* metadata not in yet */
  }
  paintPlayback(time)
}

export function bindWavePointer() {
  const wrap = document.querySelector('#recorder-wave-wrap')
  if (!wrap) return
  wrap.addEventListener('pointerdown', (event) => {
    if (panelMode !== 'playback' || !playback) return
    const visual = document.querySelector('#recorder-visual')
    const rect = visual?.getBoundingClientRect()
    const pxPerSec = rect?.width ? timelineScale(rect.width).pxPerSec : 0
    seekAnchor = { now: playback.audio?.currentTime || 0, pxPerSec }
    seeking = true
    wrap.setPointerCapture?.(event.pointerId)
    seekPlayback(timeFromPointer(event, seekAnchor))
  })
  wrap.addEventListener('pointermove', (event) => {
    if (!seeking) return
    seekPlayback(timeFromPointer(event, seekAnchor))
  })
  const end = (event) => {
    if (!seeking) return
    if (event) seekPlayback(timeFromPointer(event, seekAnchor))
    seeking = false
    seekAnchor = null
  }
  wrap.addEventListener('pointerup', end)
  wrap.addEventListener('pointercancel', () => {
    seeking = false
    seekAnchor = null
  })
}

async function decodeTakePeaks(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx || !blob?.arrayBuffer) throw new Error('decode unavailable')
  const ctx = new Ctx()
  try {
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
    const bytes = await blob.arrayBuffer()
    const buffer = await ctx.decodeAudioData(bytes.slice(0))
    const duration = Number.isFinite(buffer.duration) ? buffer.duration : 0
    const bars = Math.max(1, Math.min(20000, Math.ceil(duration / (WAVE_STEP_MS / 1000)) || 1))
    return { peaks: waveformPeaks(buffer, bars), duration }
  } finally {
    ctx.close().catch(() => {})
  }
}

async function openPlayback(take) {
  if (!take?.blob) return
  stopWaveLoop()
  releasePlayback()
  const url = URL.createObjectURL(take.blob)
  const audio = new Audio()
  audio.preload = 'auto'
  audio.src = url
  playback = {
    take,
    url,
    audio,
    peaks: take.livePeaks || null,
    peakOrigin: take.livePeakOrigin || 0,
    peakStep: WAVE_STEP_MS / 1000,
    ratio: 0,
  }
  panelMode = 'playback'
  audio.addEventListener('ended', () => {
    stopPlayLoop()
    syncPanelChrome()
    paintPlayback()
  })
  audio.addEventListener('loadedmetadata', () => {
    if (playback?.audio === audio && !seeking) paintPlayback()
  })
  syncPanelChrome()
  paintPlayback()
  markActiveTake()
  try {
    const decoded = await decodeTakePeaks(take.blob)
    if (playback?.take !== take) return
    playback.decodedDuration = Number.isFinite(decoded.duration) && decoded.duration > 0 ? decoded.duration : 0
    playback.peaks = decoded.peaks
    playback.peakOrigin = 0
    const span = playbackDuration()
    if (span > 0 && decoded.peaks.length) playback.peakStep = span / decoded.peaks.length
    paintPlayback()
  } catch {
    if (playback?.take === take) paintPlayback()
  }
}

export function togglePlayback() {
  const audio = playback?.audio
  if (!audio) return
  if (!audio.paused && !audio.ended) {
    audio.pause()
    stopPlayLoop()
    syncPanelChrome()
    paintPlayback()
    return
  }
  const duration = playbackDuration()
  if (audio.ended || (duration && audio.currentTime >= duration - 0.05)) {
    try {
      audio.currentTime = 0
    } catch {
      /* not seekable yet */
    }
  }
  audio
    .play()
    .then(() => {
      startPlayLoop()
      syncPanelChrome()
    })
    .catch(() => {
      syncPanelChrome()
    })
}

function renderTakeItem(take) {
  const when = formatTakeWhen(take.createdAt)
  const iso = takeDateIso(take.createdAt)
  const duration = formatTakeDuration(take.durationMs)
  const on = panelMode === 'playback' && playback?.take?.id === take.id
  return `
    <li class="take-row ${on ? 'is-on' : ''}" data-take-id="${take.id}">
      <button class="take-select" type="button" aria-pressed="${on ? 'true' : 'false'}" ${on ? 'aria-current="true"' : ''} aria-label="Play take from ${bridge.escapeAttr(when)}, ${bridge.escapeAttr(duration)}">
        <span class="take-meta">
          <time${iso ? ` datetime="${bridge.escapeAttr(iso)}"` : ''}>${bridge.escapeHtml(when)}</time>
          <span class="take-duration">${bridge.escapeHtml(duration)}</span>
        </span>
      </button>
    </li>`
}

export async function renderTakes() {
  const list = document.querySelector('#takes-list')
  if (!list) return
  const key = takeTextKey(bridge.current())
  const token = ++takesToken
  let takes = []
  try {
    takes = key ? await listTakes(key) : []
  } catch {
    if (token !== takesToken || !list.isConnected) return
    shownTakes = []
    list.innerHTML = '<li class="empty">Could not load takes.</li>'
    return
  }
  if (token !== takesToken || !list.isConnected || takeTextKey(bridge.current()) !== key) return
  try {
    takes = chooseTakes(takes, bridge.current())
    shownTakes = takes
    if (!takes.length) {
      list.innerHTML = '<li class="empty">No takes yet.</li>'
      return
    }
    list.innerHTML = takes.map((take) => renderTakeItem(take)).join('')
    markActiveTake()
  } catch {
    if (token !== takesToken || !list.isConnected) return
    shownTakes = []
    list.innerHTML = '<li class="empty">Could not load takes.</li>'
  }
}

function leaveRecordingPanel() {
  stopWaveLoop()
  if (panelMode === 'recording') {
    panelMode = 'closed'
    syncPanelChrome()
  }
}

async function commitTake(meta, result) {
  closeAudioGraph()
  syncRecUi()
  if (!result?.blob?.size || !meta?.textKey) {
    leaveRecordingPanel()
    return null
  }
  const exported = exportPeaks()
  const take = storedTake({ meta, result, createdAt: Date.now() })
  let diskError = false
  let diskPath
  try {
    diskPath = await saveTakeToDocuments(take)
  } catch {
    diskError = true
  }
  if (typeof diskPath === 'string' && diskPath) take.diskPath = diskPath
  return addTake(take)
    .then(async (saved) => {
      saved.livePeaks = exported.peaks
      saved.livePeakOrigin = exported.origin
      const sameText = takeTextKey(bridge.current()) === meta.textKey
      if (sameText) {
        await renderTakes()
        if (openAfterSave) await openPlayback(saved)
        else leaveRecordingPanel()
      } else leaveRecordingPanel()
      if (diskError) showRecMessage(DISK_TAKE_MESSAGE)
      return saved
    })
    .catch((error) => {
      showRecMessage(isIdbQuotaError(error) ? QUOTA_TAKE_MESSAGE : SAVE_TAKE_MESSAGE)
      leaveRecordingPanel()
      return null
    })
}

export function stopRecordingAndSave({ openAfter = true } = {}) {
  if (saveTask) return saveTask
  if (!capture.isActive()) return Promise.resolve(null)
  openAfterSave = openAfter
  const meta = recordingMeta || takeMeta()
  recordingMeta = null
  manualHold = false
  let resolveSave = () => {}
  const task = new Promise((resolve) => {
    resolveSave = resolve
  })
  saveTask = task
  pendingCommit = (result) => {
    pendingCommit = null
    stopWaveLoop()
    commitTake(meta, result).then(resolveSave)
  }
  try {
    capture.stop()
  } catch {
    pendingCommit = null
    closeAudioGraph()
    showRecMessage(SAVE_TAKE_MESSAGE)
    leaveRecordingPanel()
    resolveSave(null)
  }
  syncRecUi()
  task.finally(() => {
    if (saveTask === task) saveTask = null
  })
  return task
}

export async function startRecording() {
  if (capture.isActive()) return
  releasePlayback()
  stopPlayLoop()
  closeAudioGraph()
  ensureAudioContext()
  showRecMessage('')
  resetPeaks()
  resetRulerTrack()
  manualHold = false
  panelMode = 'recording'
  recordingMeta = takeMeta()
  syncPanelChrome()
  paintRecording()
  let result = null
  try {
    result = await openCapture()
  } catch (error) {
    recordingMeta = null
    panelMode = 'closed'
    stopWaveLoop()
    closeAudioGraph()
    syncPanelChrome()
    showRecMessage(describeMediaError(error))
    syncRecUi()
    return
  }
  if (!result?.started) {
    recordingMeta = null
    panelMode = 'closed'
    stopWaveLoop()
    closeAudioGraph()
    syncPanelChrome()
    syncRecUi()
    return
  }
  if (!recordingMeta) recordingMeta = takeMeta()
  if (capture.stream) attachAnalyser(capture.stream)
  if (panelMode !== 'recording' || !capture.isActive()) {
    closeAudioGraph()
    return
  }
  startWaveLoop()
  if (recWithRun) bridge.playRun()
  syncRecUi()
  if (capture.stream) void refreshAudioInputs()
}

export function finishRecording(options) {
  if (!capture.isActive()) return Promise.resolve(null)
  const pauseWith = recWithRun
  const task = stopRecordingAndSave(options)
  if (pauseWith) bridge.pauseRun()
  return task
}

export function toggleRecording() {
  if (capture.isActive()) return finishRecording()
  return startRecording()
}

export function pauseRecordingFromPanel() {
  if (capture.phase !== 'recording') return
  if (recWithRun) {
    manualHold = false
    bridge.pauseRun()
    return
  }
  manualHold = true
  capture.pause()
  syncRecUi()
}

export function resumeRecordingFromPanel() {
  if (capture.phase !== 'paused') return
  manualHold = false
  if (recWithRun) bridge.playRun()
  else {
    capture.resume()
    syncRecUi()
  }
}

export function onRecWithRunChange(event) {
  recWithRun = Boolean(event.target.checked)
  writeStorage(REC_WITH_RUN_KEY, JSON.stringify(recWithRun))
  syncRecorderToRun()
}

async function deleteShownTake(id) {
  const take = shownTakes.find((item) => item.id === id)
  if (!take) return
  const when = formatTakeWhen(take.createdAt)
  const duration = formatTakeDuration(take.durationMs)
  const accepted = await bridge.askConfirm({
    title: 'Delete take?',
    message: when ? `Delete the take from ${when} (${duration})?` : `Delete this take (${duration})?`,
  })
  if (!accepted) return
  try {
    await removeTake(id)
  } catch {
    showRecMessage(DELETE_TAKE_MESSAGE)
    return
  }
  if (playback?.take?.id === id) closeRecorderPanel()
  await renderTakes()
}

async function playShownTake(id) {
  const take = shownTakes.find((item) => item.id === id)
  if (!take) return
  if (panelMode === 'playback' && playback?.take?.id === id) {
    if (playback.audio?.paused || playback.audio?.ended) togglePlayback()
    return
  }
  if (capture.isActive()) await stopRecordingAndSave({ openAfter: false })
  const fresh = shownTakes.find((item) => item.id === id) || take
  await openPlayback(fresh)
}

const SHOW_TAKE_MESSAGE = 'Could not show that file.'

function takeFromRow(row) {
  const id = Number(row?.dataset.takeId)
  if (!Number.isInteger(id)) return null
  return shownTakes.find((item) => item.id === id) || null
}

function openTakeMenu(row, x, y, returnFocus) {
  const take = takeFromRow(row)
  if (!take) return
  const items = [{ label: 'Play', onSelect: () => void playShownTake(take.id) }]
  if (inTauri() && typeof take.diskPath === 'string' && take.diskPath) {
    items.push({
      label: 'Show in folder',
      onSelect: () => void showTakeInFolder(take),
    })
  }
  items.push({ label: 'Delete', danger: true, onSelect: () => void deleteShownTake(take.id) })
  openRowMenu({
    x,
    y,
    items,
    returnFocus: returnFocus instanceof HTMLElement ? returnFocus : row,
  })
}

async function showTakeInFolder(take) {
  try {
    await revealTakeFile(take.diskPath)
  } catch {
    bridge.showNotice(SHOW_TAKE_MESSAGE)
  }
}

export function onTakesContextMenu(event) {
  const source = elementFromEvent(event)
  const row = source?.closest('.take-row')
  if (!row) return
  event.preventDefault()
  openTakeMenu(row, event.clientX, event.clientY, source instanceof HTMLElement ? source : row)
}

export function onTakesMenuKey(event) {
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
  const source = elementFromEvent(event)
  const row = source?.closest('.take-row')
  if (!row) return
  event.preventDefault()
  const anchor = source instanceof HTMLElement ? source : row
  const rect = anchor.getBoundingClientRect()
  openTakeMenu(row, rect.left, rect.bottom, anchor)
}

export function onTakesClick(event) {
  const row = event.target.closest('.take-row')
  if (!row) return
  const id = Number(row.dataset.takeId)
  if (Number.isInteger(id)) void playShownTake(id)
}

export function voiceEnhanceControl(id) {
  return `<label class="voice-enhance"><input class="voice-enhance-input" id="${id}" type="checkbox" ${voiceEnhance ? 'checked' : ''} />Voice enhance</label>`
}

export function isRecWithRun() {
  return recWithRun
}

export function recordingActive() {
  return capture.isActive()
}

export function recorderPaused() {
  return capture.phase === 'paused'
}

export function recorderMode() {
  return panelMode
}

export function recorderPanelHtml() {
  return `
    <div class="recorder-panel" id="recorder-panel" data-mode="closed" aria-hidden="true" inert>
      <div class="recorder-clip">
        <div class="recorder-body">
          <div class="recorder-visual" id="recorder-visual">
            <div class="recorder-ruler" id="recorder-ruler" aria-hidden="true">
              <div class="recorder-ruler-track" id="recorder-ruler-track"></div>
            </div>
            <div class="recorder-wave-wrap" id="recorder-wave-wrap">
              <canvas id="recorder-wave" class="recorder-wave" aria-label="Recording waveform"></canvas>
            </div>
            <div class="recorder-playhead" id="recorder-playhead" aria-hidden="true"></div>
          </div>
          <div class="recorder-bar">
            <div class="recorder-mic">
              <select class="mic-select" id="recorder-mic" aria-label="Microphone"></select>
              ${voiceEnhanceControl('voice-enhance-panel')}
            </div>
            <p class="recorder-clock" id="recorder-clock">00:00.00</p>
            <div class="recorder-actions">
              <button class="btn icon-btn" id="recorder-stop" type="button" aria-label="Stop recording">${STOP_ICON}</button>
              <button class="btn icon-btn" id="recorder-pause" type="button" aria-label="Pause recording" aria-pressed="false">${PAUSE_ICON}</button>
              <button class="btn icon-btn" id="recorder-play" type="button" aria-label="Play" aria-pressed="false" hidden>${PLAY_ICON}</button>
              <button class="btn icon-btn" id="recorder-close" type="button" aria-label="Close recorder" hidden>${CLOSE_ICON}</button>
            </div>
          </div>
        </div>
      </div>
    </div>`
}

const app = document.querySelector('#app')
