import { formatClock, formatFine } from './recording.js'

export const WAVE_STEP_MS = 40
export const RULER_STEP_MS = 500
export const RULER_MAJOR_EVERY = 4
export const RULER_SIDE_MAJORS = 3.6

export function takeTextKey(item) {
  if (!item) return ''
  // Migrated essays keep their filename as the reading ID, but their existing
  // recordings were keyed by E01, E02, etc. This survives file/title edits.
  const legacyCode = item.kind === 'import' && /^E\d+.*\.txt$/i.test(item.id || '')
    ? item.id.match(/^E\d+/i)?.[0] : null
  if (legacyCode) return legacyCode
  return item.kind === 'import' ? item.id : item.code
}

export function takeMeta(item) {
  if (!item) return null
  const textKey = takeTextKey(item)
  if (!textKey) return null
  return { textKey, code: item.code || 'take', title: item.title || 'Untitled' }
}

export function formatTakeWhen(ms, locales) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locales, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function takeDateIso(ms) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString()
}

export function formatTakeDuration(ms) {
  return formatClock(ms)
}

export function timelineScale(width) {
  const centerX = width / 2
  const majorSec = (RULER_STEP_MS * RULER_MAJOR_EVERY) / 1000
  const pxPerSec = centerX / (RULER_SIDE_MAJORS * majorSec)
  return { centerX, pxPerSec }
}

/** x = centerX + (t - now) * pxPerSec. The same scale is used for the ruler and the wave. */
export function waveX(centerX, t, now, pxPerSec) {
  return centerX + (t - now) * pxPerSec
}

export function rulerMark(index, pxPerSec) {
  const tMs = index * RULER_STEP_MS
  const x = (tMs / 1000) * pxPerSec
  const major = index % RULER_MAJOR_EVERY === 0
  return { tMs, x, major }
}

export function rulerWindow(width, centerX, pxPerSec, nowSec) {
  if (width <= 0 || pxPerSec <= 0) return null
  const margin = (RULER_STEP_MS * RULER_MAJOR_EVERY) / 1000
  const leftTime = Math.max(0, nowSec - centerX / pxPerSec - margin)
  const rightTime = nowSec + Math.max(0, width - centerX) / pxPerSec + margin
  const first = Math.max(0, Math.floor((leftTime * 1000) / RULER_STEP_MS))
  const last = Math.max(first, Math.ceil((rightTime * 1000) / RULER_STEP_MS))
  const key = `${Math.round(width)}:${Math.round(pxPerSec * 100)}`
  const span = Math.max(width, ((last * RULER_STEP_MS) / 1000) * pxPerSec + 64)
  return {
    first,
    last,
    key,
    width: Math.ceil(span),
    translateX: waveX(centerX, 0, nowSec, pxPerSec),
  }
}

export function barHeight(level, height) {
  const shaped = Math.pow(Math.min(1, Math.max(0, level || 0)), 0.75)
  if (shaped < 0.05) return 0
  return Math.max(2, shaped * (height - 6))
}

export function recordingSampleWindow({ peakCount, ringSize, nowSec, centerX, pxPerSec, step = WAVE_STEP_MS / 1000 }) {
  const leftTime = nowSec - (centerX + 4) / pxPerSec
  const first = Math.max(0, peakCount - ringSize, Math.floor(leftTime / step))
  return { first, step }
}

export function playbackSampleWindow({ nowSec, centerX, pxPerSec, width, step, origin, length }) {
  const leftTime = nowSec - (centerX + 4) / pxPerSec
  const rightTime = nowSec + (width - centerX + 4) / pxPerSec
  const firstAbs = Math.floor(leftTime / step)
  const lastAbs = Math.ceil(rightTime / step)
  const first = Math.max(0, firstAbs - origin)
  const last = Math.min(length, lastAbs - origin + 1)
  return { first, last }
}

export function chooseTakes(takes, item) {
  const key = takeTextKey(item)
  if (!key || !Array.isArray(takes)) return []
  return takes.filter((take) => take && take.textKey === key).sort((a, b) => b.createdAt - a.createdAt)
}

export function storedTake({ meta, result, createdAt }) {
  return {
    textKey: meta.textKey,
    code: meta.code,
    title: meta.title,
    createdAt,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    mimeType: result.mimeType,
    extension: result.extension,
    blob: result.blob,
  }
}

export function recControlState(phase) {
  const live = phase === 'recording' || phase === 'paused'
  const paused = phase === 'paused'
  return {
    pressed: live ? 'true' : 'false',
    recording: live,
    paused,
    label: live ? (paused ? 'Stop recording, paused' : 'Stop recording') : 'Start recording',
  }
}

export function panelChromeState({ mode, phase, playbackPaused }) {
  const open = mode === 'recording' || mode === 'playback'
  const recording = mode === 'recording'
  const playing = mode === 'playback'
  const recordPaused = phase === 'paused'
  return {
    open,
    mode,
    hidden: open ? 'false' : 'true',
    stopHidden: !recording,
    pauseHidden: !recording,
    pauseLabel: recordPaused ? 'Resume recording' : 'Pause recording',
    pausePressed: recordPaused ? 'true' : 'false',
    pauseShowsPlay: recordPaused,
    playHidden: !playing,
    playLabel: playbackPaused ? 'Play' : 'Pause',
    playPressed: playbackPaused ? 'false' : 'true',
    playShowsPlay: playbackPaused,
    closeHidden: !playing,
    waveLabel: playing ? 'Playback waveform' : 'Recording waveform',
  }
}

export function recordingBusy(phase) {
  return phase === 'starting' || phase === 'recording' || phase === 'paused' || phase === 'stopping'
}

export function micControlState({ mode, phase }) {
  return {
    panelOpen: mode === 'recording' || mode === 'playback',
    busy: mode === 'recording' || recordingBusy(phase),
  }
}

export function playbackNowSec(current, duration) {
  return duration > 0 ? Math.min(duration, Math.max(0, current)) : Math.max(0, current)
}

export function playbackRatio(nowSec, duration) {
  return duration > 0 ? nowSec / duration : 0
}

export function playbackClockText(nowMs, durationMs) {
  return `${formatFine(nowMs)} / ${formatFine(durationMs)}`
}
