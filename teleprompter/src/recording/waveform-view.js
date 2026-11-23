/**
 * Waveform, ruler, and playback seeking. Samples the microphone analyser.
 */
import { formatFine, sampleLevel, waveformPeaks } from './recording.js'
import {
  WAVE_STEP_MS,
  barHeight,
  playbackClockText,
  playbackNowSec,
  playbackRatio,
  playbackSampleWindow,
  recordingSampleWindow,
  rulerMark,
  rulerWindow,
  timeAtPointer,
  timelineScale,
  waveX,
} from './recorder-math.js'

const PEAK_RING_SIZE = 16384

export function clampUnit(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  if (number >= 1) return 1
  return number
}

/** Same mix as sampleLevel: the louder of the peak and 2.5× RMS, clamped to 0–1. */
export function meterLevel(meter) {
  if (!meter) return 0
  const peak = Math.abs(Number(meter.peak) || 0)
  const rms = Math.abs(Number(meter.rms) || 0)
  return clampUnit(Math.max(peak, rms * 2.5))
}

/** Write one native peak batch into the ring. `startIndex` is the first bar. */
export function applyPeakBatch(ring, count, size, batch) {
  const values = batch?.values
  if (!values || typeof values.length !== 'number' || size <= 0) return count
  const start = Number(batch.startIndex)
  const origin = Number.isFinite(start) && start > 0 ? Math.floor(start) : 0
  let next = count
  for (let i = 0; i < values.length; i += 1) {
    const index = origin + i
    ring[index % size] = clampUnit(values[i])
    if (index + 1 > next) next = index + 1
  }
  return next
}

export function exportPeakSlice(ring, count, size) {
  const available = Math.min(count, size)
  const origin = count - available
  const peaks = new Float32Array(available)
  for (let i = 0; i < available; i += 1) peaks[i] = ring[(origin + i) % size]
  return { peaks, origin }
}

export function playbackDurationSec(playback) {
  const audio = playback?.audio
  if (audio && Number.isFinite(audio.duration) && audio.duration > 0 && audio.duration !== Infinity) return audio.duration
  if (Number.isFinite(playback?.decodedDuration) && playback.decodedDuration > 0) return playback.decodedDuration
  const ms = playback?.take?.durationMs
  if (ms > 0) return ms / 1000
  return 0
}

export function nextWaveColors(cache, theme, colors) {
  if (cache.theme === theme && cache.ink) return cache
  return {
    theme,
    wave: colors.wave || '#6f6961',
    ink: colors.ink || '#1d1b18',
    line: colors.line || '#c6bbac',
  }
}

export function createWaveformView({ getAnalyser, resumeAudio, getElapsedMs, getCapturePhase, getPanelMode, getPlayback }) {
  const peakRing = new Float32Array(PEAK_RING_SIZE)
  let peakCount = 0
  let peakLive = 0
  let externalPeaks = false
  let externalLive = 0
  let sampleStepMs = WAVE_STEP_MS
  let rulerBuilt = { key: '', have: new Set() }
  let waveGen = 0
  let playGen = 0
  let seeking = false
  let seekAnchor = null
  let colorCache = { theme: '', ink: '', line: '' }

  function invalidateColors() {
    colorCache = { theme: '', ink: '', line: '' }
  }

  function themeColors() {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
    if (colorCache.theme === theme && colorCache.ink) return colorCache
    const style = getComputedStyle(document.documentElement)
    colorCache = nextWaveColors(colorCache, theme, {
      wave: style.getPropertyValue('--muted').trim(),
      ink: style.getPropertyValue('--ink').trim(),
      line: style.getPropertyValue('--line-strong').trim(),
    })
    return colorCache
  }

  function onThemeChange() {
    invalidateColors()
    const mode = getPanelMode()
    if (mode === 'recording') paintRecording()
    else if (mode === 'playback') paintPlayback()
  }

  function resetPeaks() {
    peakCount = 0
    peakLive = 0
    externalLive = 0
    externalPeaks = false
    sampleStepMs = WAVE_STEP_MS
  }

  function armExternalPeaks(stepMs) {
    externalPeaks = true
    const step = Number(stepMs)
    sampleStepMs = step > 0 ? step : WAVE_STEP_MS
  }

  function disarmExternalPeaks() {
    externalPeaks = false
    externalLive = 0
    sampleStepMs = WAVE_STEP_MS
  }

  function ingestMeter(meter) {
    if (!externalPeaks) return
    externalLive = meterLevel(meter)
    peakLive = externalLive
  }

  function ingestPeaks(batch) {
    if (!externalPeaks) return
    peakCount = applyPeakBatch(peakRing, peakCount, PEAK_RING_SIZE, batch)
  }

  function pushPeak(level) {
    peakRing[peakCount % PEAK_RING_SIZE] = level
    peakCount += 1
  }

  function peakAt(index) {
    return peakRing[index % PEAK_RING_SIZE]
  }

  function exportPeaks() {
    return exportPeakSlice(peakRing, peakCount, PEAK_RING_SIZE)
  }

  function resetRulerTrack() {
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
      step: sampleStepMs / 1000,
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

  function paintRecording() {
    resumeAudio()
    const elapsed = getElapsedMs()
    const nowSec = Math.max(0, elapsed / 1000)
    if (getCapturePhase() === 'recording') {
      if (externalPeaks) {
        peakLive = externalLive
      } else {
        const expected = Math.floor(elapsed / WAVE_STEP_MS)
        let guard = 0
        while (peakCount < expected && guard < 8) {
          pushPeak(sampleLevel(getAnalyser()))
          guard += 1
        }
        peakLive = sampleLevel(getAnalyser())
      }
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
      if (gen !== waveGen || getPanelMode() !== 'recording') return
      paintRecording()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  function stopWaveLoop() {
    waveGen += 1
  }

  function playbackDuration() {
    return playbackDurationSec(getPlayback())
  }

  function paintPlayback(forcedTime) {
    const playback = getPlayback()
    if (getPanelMode() !== 'playback' || !playback) return
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
      const playback = getPlayback()
      if (!playback?.audio || playback.audio.paused || playback.audio.ended) return
      if (!seeking) paintPlayback()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  function stopPlayLoop() {
    playGen += 1
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
    const playback = getPlayback()
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

  function bindWavePointer() {
    const wrap = document.querySelector('#recorder-wave-wrap')
    if (!wrap) return
    wrap.addEventListener('pointerdown', (event) => {
      const playback = getPlayback()
      if (getPanelMode() !== 'playback' || !playback) return
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

  function clearSeek() {
    seeking = false
    seekAnchor = null
  }

  function isSeeking() {
    return seeking
  }

  return {
    invalidateColors,
    onThemeChange,
    resetPeaks,
    armExternalPeaks,
    disarmExternalPeaks,
    ingestMeter,
    ingestPeaks,
    exportPeaks,
    resetRulerTrack,
    paintRecording,
    paintPlayback,
    startWaveLoop,
    stopWaveLoop,
    startPlayLoop,
    stopPlayLoop,
    bindWavePointer,
    decodeTakePeaks,
    playbackDuration,
    clearSeek,
    isSeeking,
  }
}
