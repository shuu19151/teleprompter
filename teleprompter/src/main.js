import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/literata/latin-400.css'
import '@fontsource/literata/latin-700.css'
import './style.css'
import { isEssayFile } from './essay-files.js'
import {
  addTake,
  createCapture,
  describeMediaError,
  formatClock,
  formatFine,
  isQuotaError as isIdbQuotaError,
  listTakes,
  removeTake,
  sampleLevel,
  takeFileName,
  warmRecordingStore,
  waveformPeaks,
} from './recording.js'

const THEME_KEY = 'teleprompter:theme'
const SPEED_KEY = 'teleprompter:speed'
const ESSAY_KEY = 'teleprompter:essay'
const POSITION_KEY = 'teleprompter:position'
const FONT_KEY = 'teleprompter:fontSize'
const IMPORTS_KEY = 'teleprompter:imports'
const REC_WITH_RUN_KEY = 'teleprompter:recWithRun'
const MIC_KEY = 'teleprompter:micId'
const QUOTA_TAKE_MESSAGE = 'Could not save this take because browser storage is full.'
const SAVE_TAKE_MESSAGE = 'Could not save this take.'
const DELETE_TAKE_MESSAGE = 'Could not delete this take.'
const FONT_MIN = 24
const FONT_MAX = 56
const FONT_DEFAULT = 32
const READING_RATIO = 1 / 3
const SAVE_DELAY = 300
const MAX_IMPORT_BYTES = 200 * 1024
const EMPTY_IMPORT_MESSAGE = 'Paste some text or choose a .txt or .md file.'
const SIZE_IMPORT_MESSAGE = 'That text is larger than 200 KB.'
const TYPE_IMPORT_MESSAGE = 'Choose a .txt or .md file.'
const READ_IMPORT_MESSAGE = 'Could not read that file.'
const QUOTA_IMPORT_MESSAGE = 'Could not save this text because browser storage is full.'
const ENTER_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H4v4"/><path d="M16 4h4v4"/><path d="M4 16v4h4"/><path d="M20 16v4h-4"/></svg>`
const EXIT_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M4 15h5v5"/><path d="M20 15h-5v5"/></svg>`
const STOP_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5" fill="currentColor"/></svg>`
const PAUSE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>`
const PLAY_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.2v13.6l11-6.8z"/></svg>`
const CLOSE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`
const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7.5 11.5 12 16l4.5-4.5"/><path d="M5 19h14"/></svg>`
const MIC_ICON = `<svg class="mic-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M8.5 21h7"/></svg>`
const WAVE_STEP_MS = 40
const RULER_STEP_MS = 400
const RULER_MAJOR_EVERY = 4
// Major labels every 1.6s. 4.5 of them fit on each side of the playhead,
// so 00:06.40 through 00:11.20 stay on screen when the head is at 00:04.80.
const RULER_SIDE_MAJORS = 4.5
const LEGACY_KEYS = {
  [THEME_KEY]: 'office-essay:theme',
  [SPEED_KEY]: 'office-essay:speed',
}

// Case-sensitive E*.txt, matching isEssayFile and /api/essays.
const files = import.meta.glob('../../essays/E*.txt', { query: '?raw', import: 'default', eager: true })

const SMALL = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs'])

function titleCase(raw) {
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => {
      if (index > 0 && SMALL.has(word)) return word
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

function parseEssay(path, raw) {
  const file = path.split('/').pop()
  const code = file.match(/E\d+/)?.[0] ?? file
  const text = raw.replace(/\r\n/g, '\n').trim()
  const gap = text.indexOf('\n\n')
  const title = gap === -1 ? text : text.slice(0, gap)
  const body = gap === -1 ? '' : text.slice(gap + 2)
  const words = text.split(/\s+/).filter(Boolean).length
  return {
    kind: 'essay',
    code,
    file,
    title: titleCase(title),
    body,
    words,
    minutes: Math.max(1, Math.round(words / 130)),
  }
}

function textBytes(value) {
  return new TextEncoder().encode(value).length
}

function fileBaseName(name) {
  return String(name ?? '').split(/[/\\]/).pop() ?? ''
}

function isTextFileName(name) {
  return /\.(txt|md)$/i.test(fileBaseName(name))
}

function isMarkdownName(name) {
  return /\.md$/i.test(fileBaseName(name))
}

function prettyFileName(name) {
  const stripped = fileBaseName(name).replace(/\.(txt|md)$/i, '').trim()
  if (!stripped) return ''
  return titleCase(stripped.replace(/[-_]+/g, ' '))
}

function stripMarkdownHeadings(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^#{1,6}(?:[ \t]+|$)/, ''))
    .join('\n')
}

function clampTitle(value) {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (clean.length <= 180) return clean
  return `${clean.slice(0, 179).trimEnd()}…`
}

function newImportId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isQuotaError(error) {
  if (!error) return false
  if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  return error.code === 22 || error.code === 1014
}

function loadImports() {
  const data = loadJSON(IMPORTS_KEY)
  if (!Array.isArray(data)) return []
  return data
    .filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string')
    .map((item) => {
      const stored = {
        id: item.id,
        title: item.title,
        body: item.body,
        createdAt: typeof item.createdAt === 'string' || typeof item.createdAt === 'number' ? item.createdAt : new Date().toISOString(),
      }
      if (typeof item.updatedAt === 'string' || typeof item.updatedAt === 'number') stored.updatedAt = item.updatedAt
      return stored
    })
}

function writeImports(list) {
  try {
    localStorage.setItem(IMPORTS_KEY, JSON.stringify(list))
    return { ok: true }
  } catch (error) {
    return { ok: false, quota: isQuotaError(error) }
  }
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsText(file, 'UTF-8')
  })
}

/**
 * Same title-block split as parseEssay: text before the first blank line is the
 * title, and the rest is the script. A typed title replaces that block. With no
 * blank line, the first line (or the file name) is the title and the text stays
 * on the stage. Markdown files drop leading # heading marks only.
 */
function parseImportedText(raw, { title = '', fileName = '', markdown = false } = {}) {
  if (typeof raw !== 'string') return { error: EMPTY_IMPORT_MESSAGE }
  if (textBytes(raw) > MAX_IMPORT_BYTES) return { error: SIZE_IMPORT_MESSAGE }
  let text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (markdown || isMarkdownName(fileName)) text = stripMarkdownHeadings(text)
  text = text.trim()
  if (!text) return { error: EMPTY_IMPORT_MESSAGE }

  const gap = text.indexOf('\n\n')
  const titleBlock = gap === -1 ? text : text.slice(0, gap)
  const script = gap === -1 ? '' : text.slice(gap + 2)
  const given = title.trim()
  let finalTitle = given
  let body = script
  if (!finalTitle) {
    if (script) finalTitle = titleCase(titleBlock)
    else if (prettyFileName(fileName)) {
      finalTitle = prettyFileName(fileName)
      body = text
    } else {
      const firstLine = text.split('\n').find((line) => line.trim())?.trim() ?? ''
      const rest = text.split('\n').slice(1).join('\n').trim()
      finalTitle = firstLine ? titleCase(firstLine) : ''
      body = rest || text
    }
  } else if (!body) {
    body = text
  }
  finalTitle = clampTitle(finalTitle)
  if (!finalTitle) finalTitle = prettyFileName(fileName) || 'Untitled'
  return { title: finalTitle, body }
}

function readStorage(key) {
  try {
    const value = localStorage.getItem(key)
    if (value !== null) return value
    const legacy = LEGACY_KEYS[key]
    if (!legacy) return null
    const old = localStorage.getItem(legacy)
    if (old === null) return null
    try {
      localStorage.setItem(key, old)
    } catch {
      /* still use the legacy value */
    }
    return old
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

function loadSpeed() {
  try {
    const raw = readStorage(SPEED_KEY)
    if (raw === null) return 20
    const saved = Number(JSON.parse(raw))
    if (Number.isInteger(saved) && saved >= 1 && saved <= 50) return saved
  } catch {
    /* keep the default */
  }
  return 20
}

function loadFontSize() {
  const saved = Number(loadJSON(FONT_KEY))
  if (Number.isInteger(saved) && saved >= FONT_MIN && saved <= FONT_MAX) return saved
  return FONT_DEFAULT
}

function loadRecWithRun() {
  const saved = loadJSON(REC_WITH_RUN_KEY)
  if (typeof saved === 'boolean') return saved
  return true
}

let essays = Object.entries(files)
  .filter(([path]) => isEssayFile(path))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, raw]) => parseEssay(path, raw))

let imports = loadImports()
let importFileName = ''
let importMarkdown = false
let importReturnFocus = null
let editingId = null
let confirmResolver = null
let confirmReturnFocus = null

const state = {
  index: 0,
  kind: 'essay',
  importId: null,
  query: '',
  drawer: false,
  running: false,
  speed: loadSpeed(),
  fontSize: loadFontSize(),
  offset: 0,
}

let raf = 0
let lastTime = 0
let wheelLeft = 0
let anchor = null
let activeIndex = -1
let lineNodes = []
let lineMetrics = []
let offsetCache = { width: 0, height: 0, focusShift: 0, max: 0 }
let needsRestore = true
let restoredAnchor = null
let saveTimer = 0
let recWithRun = loadRecWithRun()
let recordingMeta = null
let saveTask = null
let pendingCommit = null
let takesToken = 0
let panelMode = 'closed'
let manualHold = false
let micId = loadMicId()
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
let rulerBuilt = { key: '', count: 0 }
let waveGen = 0
let playGen = 0
let seeking = false
let seekAnchor = null
let playback = null
let shownTakes = []
const takeUrls = new Set()
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

function pixelsPerSecond() {
  return state.speed * 2.5
}

function readingFromTop() {
  return offsetCache.height * READING_RATIO
}

/** Script-space Y of the guide, one third down the stage. */
function scriptFocusY() {
  return state.offset + readingFromTop() - offsetCache.focusShift
}

function offsetForFraction(top, height, fraction) {
  return top + fraction * height - readingFromTop() + offsetCache.focusShift
}

function fractionAtOffset(top, height) {
  return (scriptFocusY() - top) / (height || 1)
}

function maxOffset() {
  return offsetCache.max
}

function renderLines(body) {
  return body
    .split('\n')
    .map((line) => (line.trim() ? `<p class="line">${escapeHtml(line)}</p>` : '<div class="gap"></div>'))
    .join('')
}

function scriptLineCount(body) {
  return String(body ?? '')
    .split('\n')
    .filter((line) => line.trim()).length
}

function measure() {
  const view = document.querySelector('#text-view')
  const script = document.querySelector('#text-script')
  if (!view || !script) {
    lineNodes = []
    lineMetrics = []
    offsetCache = { width: 0, height: 0, focusShift: 0, max: 0 }
    return
  }
  // A transform makes the script the offsetParent, matching re-anchor math.
  script.style.transform = `translateY(${-state.offset}px)`
  const style = getComputedStyle(view)
  const padTop = parseFloat(style.paddingTop) || 0
  const padBottom = parseFloat(style.paddingBottom) || 0
  const borderTop = parseFloat(style.borderTopWidth) || 0
  const height = view.clientHeight
  const width = view.clientWidth
  if (height > 0) {
    const guide = height * READING_RATIO
    script.style.paddingTop = `${guide}px`
    script.style.paddingBottom = `${Math.max(guide, height - guide)}px`
  }
  const nodes = [...script.querySelectorAll('.line')]
  lineNodes = nodes
  lineMetrics = nodes.map((line) => {
    const top = line.offsetTop
    const lineHeight = line.offsetHeight
    return { top, height: lineHeight, center: top + lineHeight / 2 }
  })
  offsetCache = {
    width,
    height,
    focusShift: padTop + borderTop,
    max: Math.max(0, script.offsetHeight - (height - padTop - padBottom)),
  }
}

function findActiveIndex(focusY) {
  const last = lineMetrics.length - 1
  if (last <= 0) return 0
  if (focusY <= lineMetrics[0].center) return 0
  if (focusY >= lineMetrics[last].center) return last
  let low = 0
  let high = last
  while (low + 1 < high) {
    const mid = (low + high) >> 1
    if (lineMetrics[mid].center <= focusY) low = mid
    else high = mid
  }
  const lowDistance = focusY - lineMetrics[low].center
  const highDistance = lineMetrics[high].center - focusY
  return lowDistance <= highDistance ? low : high
}

function paintFocus(next) {
  const start = activeIndex < 0 ? 0 : Math.max(0, Math.min(activeIndex, next) - 1)
  const end = activeIndex < 0 ? lineNodes.length - 1 : Math.min(lineNodes.length - 1, Math.max(activeIndex, next))
  for (let index = start; index <= end; index += 1) {
    const line = lineNodes[index]
    const delta = index - next
    line.classList.toggle('is-active', delta === 0)
    line.classList.toggle('is-past', delta < 0)
    line.classList.toggle('is-near', delta === -1)
  }
  activeIndex = next
}

function updateFocus() {
  if (!lineMetrics.length) return
  const next = findActiveIndex(scriptFocusY())
  if (next === activeIndex) return
  paintFocus(next)
}

function reanchor() {
  if (!anchor || !lineMetrics.length) return
  if (anchor.width === offsetCache.width && anchor.height === offsetCache.height) return
  const metric = lineMetrics[anchor.index]
  if (!metric) return
  const target = offsetForFraction(metric.top, metric.height, anchor.fraction)
  state.offset = Math.min(offsetCache.max, Math.max(0, target))
}

function captureAnchor() {
  const metric = lineMetrics[activeIndex]
  if (!metric) {
    anchor = null
    return
  }
  anchor = {
    index: activeIndex,
    fraction: fractionAtOffset(metric.top, metric.height),
    width: offsetCache.width,
    height: offsetCache.height,
  }
}

function formatRemaining(seconds) {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0))
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes}:${String(secs).padStart(2, '0')} left`
}

function updateProgress() {
  const bar = document.querySelector('#progress-bar')
  const label = document.querySelector('#progress-time')
  if (!bar && !label) return
  const max = offsetCache.max
  const ratio = max > 0 ? Math.min(1, Math.max(0, state.offset / max)) : 0
  if (bar) {
    bar.style.transform = `scaleX(${ratio})`
    bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  }
  if (label) {
    const rate = pixelsPerSecond()
    const seconds = rate > 0 ? Math.max(0, max - state.offset) / rate : 0
    label.textContent = formatRemaining(seconds)
  }
}

function applyOffset() {
  reanchor()
  const script = document.querySelector('#text-script')
  if (script) script.style.transform = `translateY(${-state.offset}px)`
  updateFocus()
  captureAnchor()
  updateProgress()
}

const resizeObserver = new ResizeObserver(() => {
  measure()
  applyOffset()
})

let recorderResizeObserver = null

function watchRecorderSize() {
  const visual = document.querySelector('#recorder-visual')
  if (!visual || typeof ResizeObserver === 'undefined') return
  if (!recorderResizeObserver) {
    recorderResizeObserver = new ResizeObserver(() => {
      if (panelMode === 'recording') paintRecording()
      else if (panelMode === 'playback') paintPlayback()
    })
  }
  recorderResizeObserver.disconnect()
  recorderResizeObserver.observe(visual)
}

function syncRunButton() {
  const button = document.querySelector('#run')
  if (!button) return
  button.textContent = state.running ? 'Pause' : 'Run'
  button.classList.toggle('btn-next', !state.running)
  button.setAttribute('aria-pressed', state.running ? 'true' : 'false')
}

function stopLoop() {
  cancelAnimationFrame(raf)
  raf = 0
  lastTime = 0
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveProgress, SAVE_DELAY)
}

function saveProgressNow() {
  clearTimeout(saveTimer)
  saveTimer = 0
  saveProgress()
}

function itemKey(item) {
  if (!item) return ''
  return item.kind === 'import' ? item.id : item.file
}

function saveProgress() {
  const essay = current()
  if (!essay) return
  const id = itemKey(essay)
  writeStorage(
    ESSAY_KEY,
    JSON.stringify({
      file: essay.file,
      code: essay.code,
      kind: essay.kind || 'essay',
      id,
    }),
  )
  const metric = lineMetrics[activeIndex]
  if (metric && offsetCache.height) {
    const fraction = fractionAtOffset(metric.top, metric.height)
    writeStorage(POSITION_KEY, JSON.stringify({ index: activeIndex, fraction, id }))
    return
  }
  writeStorage(POSITION_KEY, JSON.stringify({ offset: state.offset, id }))
}

function tick(now) {
  const gliding = Math.abs(wheelLeft) > 0.5
  if (!state.running && !gliding) {
    stopLoop()
    return
  }
  if (!lastTime) lastTime = now
  const dt = Math.min(0.05, (now - lastTime) / 1000)
  lastTime = now
  if (state.running) state.offset += pixelsPerSecond() * dt
  if (gliding) {
    const step = wheelLeft * (1 - Math.exp(-dt / 0.16))
    wheelLeft -= step
    state.offset += step
  }
  const limit = maxOffset()
  if (state.offset >= limit) {
    state.offset = limit
    wheelLeft = Math.min(0, wheelLeft)
    if (state.running) {
      state.running = false
      syncRunButton()
      saveProgressNow()
      syncRecorderToRun()
    }
  } else if (state.offset < 0) {
    state.offset = 0
    wheelLeft = Math.max(0, wheelLeft)
  }
  applyOffset()
  scheduleSave()
  if (!state.running && Math.abs(wheelLeft) <= 0.5) {
    wheelLeft = 0
    stopLoop()
    return
  }
  raf = requestAnimationFrame(tick)
}

function startLoop() {
  stopLoop()
  raf = requestAnimationFrame(tick)
}

function wheelDistance(event) {
  const view = document.querySelector('#text-view')
  if (event.deltaMode === 1) return event.deltaY * 16
  if (event.deltaMode === 2) return event.deltaY * (view?.clientHeight || 0)
  return event.deltaY
}

function scrollBy(distance) {
  if (!distance) return
  const limit = maxOffset()
  const destination = Math.min(limit, Math.max(0, state.offset + wheelLeft + distance))
  wheelLeft = destination - state.offset
  if (!raf) startLoop()
}

function toTop() {
  state.running = false
  syncRunButton()
  syncRecorderToRun()
  wheelLeft = -state.offset
  if (Math.abs(wheelLeft) <= 0.5) {
    wheelLeft = 0
    state.offset = 0
    applyOffset()
    stopLoop()
    scheduleSave()
    return
  }
  if (!raf) startLoop()
}

function pauseRun() {
  if (!state.running) {
    syncRecorderToRun()
    return
  }
  state.running = false
  syncRunButton()
  saveProgressNow()
  if (Math.abs(wheelLeft) <= 0.5) stopLoop()
  syncRecorderToRun()
}

function playRun() {
  const essay = current()
  if (!essay?.body) return false
  if (state.running) {
    syncRecorderToRun()
    return true
  }
  if (state.offset >= maxOffset() - 1) {
    state.offset = 0
    applyOffset()
  }
  state.running = true
  syncRunButton()
  startLoop()
  syncRecorderToRun()
  return true
}

function toggleRun() {
  if (state.running) pauseRun()
  else playRun()
}

// With "Start scrolling with recording" on, MediaRecorder pauses and resumes
// with Run. With it off, scrolling leaves the recorder alone, except a pause
// the reader started from the panel (manualHold) stays paused.
function syncRecorderToRun() {
  if (capture.phase !== 'recording' && capture.phase !== 'paused') return
  if (!recWithRun) {
    if (!manualHold) capture.resume()
    syncRecUi()
    return
  }
  if (state.running) {
    manualHold = false
    capture.resume()
  } else capture.pause()
  syncRecUi()
}

function takeTextKey(item) {
  if (!item) return ''
  return item.kind === 'import' ? item.id : item.code
}

function takeMeta() {
  const item = current()
  if (!item) return null
  const textKey = takeTextKey(item)
  if (!textKey) return null
  return { textKey, code: item.code || 'take', title: item.title || 'Untitled' }
}

function showRecMessage(message) {
  const text = message || ''
  for (const el of document.querySelectorAll('[data-rec-message]')) {
    el.textContent = text
    el.hidden = !text
  }
}

function syncRecUi() {
  const live = capture.phase === 'recording' || capture.phase === 'paused'
  const paused = capture.phase === 'paused'
  const label = live ? (paused ? 'Stop recording, paused' : 'Stop recording') : 'Start recording'
  for (const button of document.querySelectorAll('#rec, #rec-stage')) {
    button.setAttribute('aria-pressed', live ? 'true' : 'false')
    button.classList.toggle('is-recording', live)
    button.classList.toggle('is-paused', paused)
    button.setAttribute('aria-label', label)
  }
  if (panelMode === 'recording') syncPanelChrome()
}

function revokeTakeUrls() {
  for (const url of takeUrls) URL.revokeObjectURL(url)
  takeUrls.clear()
}

function formatTakeWhen(ms) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function formatTakeDuration(ms) {
  return formatClock(ms)
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
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new Ctx()
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

function saveMicId(id) {
  micId = id || ''
  try {
    if (micId) localStorage.setItem(MIC_KEY, micId)
    else localStorage.removeItem(MIC_KEY)
  } catch {
    /* ignore quota or private mode */
  }
}

function recordingBusy() {
  return capture.phase === 'starting' || capture.phase === 'recording' || capture.phase === 'paused' || capture.phase === 'stopping'
}

function syncMicControls() {
  const row = document.querySelector('#mic-row')
  const panelOpen = panelMode === 'recording' || panelMode === 'playback'
  if (row) row.hidden = panelOpen
  const busy = panelMode === 'recording' || recordingBusy()
  for (const select of document.querySelectorAll('select.mic-select')) select.disabled = busy
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

function onMicChange(event) {
  const value = event.target.value || ''
  if (value === micId) {
    renderMicSelects()
    return
  }
  saveMicId(value)
  renderMicSelects()
}

function micConstraint() {
  if (!micId) return true
  if (audioInputs.length && !audioInputs.some((device) => device.deviceId === micId)) return true
  return { deviceId: { exact: micId } }
}

function isMissingMicError(error) {
  const name = error?.name || ''
  return name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'DevicesNotFoundError'
}

async function openCapture() {
  const constraint = micConstraint()
  try {
    return await capture.start(constraint)
  } catch (error) {
    if (constraint !== true && isMissingMicError(error)) {
      saveMicId('')
      renderMicSelects()
      return capture.start(true)
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

/** x = centerX + (t - now) * pxPerSec. The same scale is used for the ruler and the wave. */
function timelineScale(width) {
  const centerX = width / 2
  const majorSec = (RULER_STEP_MS * RULER_MAJOR_EVERY) / 1000
  const pxPerSec = centerX / (RULER_SIDE_MAJORS * majorSec)
  return { centerX, pxPerSec }
}

function resetRulerTrack() {
  rulerBuilt = { key: '', count: 0 }
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
  const tMs = index * RULER_STEP_MS
  const x = (tMs / 1000) * pxPerSec
  const major = index % RULER_MAJOR_EVERY === 0
  const tick = document.createElement('span')
  tick.className = major ? 'ruler-tick major' : 'ruler-tick minor'
  tick.dataset.ms = String(tMs)
  tick.style.left = `${x}px`
  track.appendChild(tick)
  if (!major) return
  const label = document.createElement('span')
  label.className = 'ruler-label'
  label.dataset.ms = String(tMs)
  label.style.left = `${x}px`
  label.textContent = formatFine(tMs)
  track.appendChild(label)
}

/**
 * Slide one ruler track. Marks are appended as the visible future grows,
 * not rebuilt every frame. The track is wider than the panel so later marks
 * are not clipped before the translate brings them on screen. Times before
 * 00:00.00 are never created. The waveform, not the ruler, stops at the playhead.
 */
function placeRuler(width, centerX, pxPerSec, nowSec) {
  const track = document.querySelector('#recorder-ruler-track')
  if (!track || width <= 0 || pxPerSec <= 0) return
  const ahead = width / 2 / pxPerSec
  const majorSec = (RULER_STEP_MS * RULER_MAJOR_EVERY) / 1000
  const limit = Math.max(0, nowSec) + ahead + majorSec
  const key = `${Math.round(width)}:${Math.round(pxPerSec * 100)}`
  if (rulerBuilt.key !== key) {
    track.replaceChildren()
    rulerBuilt = { key, count: 0 }
  }
  const last = Math.floor((limit * 1000) / RULER_STEP_MS + 1e-6)
  while (rulerBuilt.count <= last) {
    addRulerMark(track, rulerBuilt.count, pxPerSec)
    rulerBuilt.count += 1
  }
  const span = Math.max(width, ((last * RULER_STEP_MS) / 1000) * pxPerSec + 64)
  const widthPx = `${Math.ceil(span)}px`
  if (track.style.width !== widthPx) track.style.width = widthPx
  track.style.transform = `translateX(${centerX - nowSec * pxPerSec}px)`
}

function drawBaseline(ctx, width, height, color) {
  const mid = height / 2
  ctx.fillStyle = color
  ctx.fillRect(0, mid - 0.5, width, 1)
}

function barHeight(level, height) {
  const shaped = Math.pow(Math.min(1, Math.max(0, level || 0)), 0.75)
  if (shaped < 0.05) return 0
  return Math.max(2, shaped * (height - 6))
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
  const step = WAVE_STEP_MS / 1000
  const leftTime = nowSec - (centerX + 4) / pxPerSec
  const first = Math.max(0, peakCount - PEAK_RING_SIZE, Math.floor(leftTime / step))
  for (let i = first; i < peakCount; i += 1) {
    const t = (i + 0.5) * step
    const x = centerX + (t - nowSec) * pxPerSec
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
  const leftTime = nowSec - (centerX + 4) / pxPerSec
  const rightTime = nowSec + (width - centerX + 4) / pxPerSec
  const firstAbs = Math.floor(leftTime / step)
  const lastAbs = Math.ceil(rightTime / step)
  const first = Math.max(0, firstAbs - origin)
  const last = Math.min(peaks.length, lastAbs - origin + 1)
  for (let i = first; i < last; i += 1) {
    const t = (origin + i + 0.5) * step
    if (t < 0) continue
    const x = centerX + (t - nowSec) * pxPerSec
    if (x < -4 || x > width + 4) continue
    const bar = barHeight(peaks[i], height)
    if (bar <= 0) continue
    drawBar(ctx, x, mid, bar)
  }
}

function paintRecording() {
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

function paintPlayback(forcedTime) {
  if (panelMode !== 'playback' || !playback) return
  const duration = playbackDuration()
  const current = forcedTime != null ? forcedTime : playback.audio?.currentTime || 0
  const nowSec = duration > 0 ? Math.min(duration, Math.max(0, current)) : Math.max(0, current)
  playback.ratio = duration > 0 ? nowSec / duration : 0
  const clock = document.querySelector('#recorder-clock')
  if (clock) clock.textContent = `${formatFine(nowSec * 1000)} / ${formatFine(duration * 1000)}`
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
  const open = panelMode === 'recording' || panelMode === 'playback'
  panel.classList.toggle('is-open', open)
  panel.dataset.mode = panelMode
  panel.setAttribute('aria-hidden', open ? 'false' : 'true')
  if (open) panel.removeAttribute('inert')
  else panel.setAttribute('inert', '')
  const recording = panelMode === 'recording'
  const playing = panelMode === 'playback'
  const stop = panel.querySelector('#recorder-stop')
  const pause = panel.querySelector('#recorder-pause')
  const play = panel.querySelector('#recorder-play')
  const close = panel.querySelector('#recorder-close')
  if (stop) stop.hidden = !recording
  if (pause) {
    pause.hidden = !recording
    const paused = capture.phase === 'paused'
    pause.innerHTML = paused ? PLAY_ICON : PAUSE_ICON
    pause.setAttribute('aria-label', paused ? 'Resume recording' : 'Pause recording')
    pause.setAttribute('aria-pressed', paused ? 'true' : 'false')
  }
  if (play) {
    play.hidden = !playing
    const paused = !playback?.audio || playback.audio.paused || playback.audio.ended
    play.innerHTML = paused ? PLAY_ICON : PAUSE_ICON
    play.setAttribute('aria-label', paused ? 'Play' : 'Pause')
    play.setAttribute('aria-pressed', paused ? 'false' : 'true')
  }
  if (close) close.hidden = !playing
  syncMicControls()
  const canvas = panel.querySelector('#recorder-wave')
  if (canvas) canvas.setAttribute('aria-label', playing ? 'Playback waveform' : 'Recording waveform')
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

function closeRecorderPanel() {
  if (panelMode === 'recording' && capture.isActive()) return
  const panel = document.querySelector('#recorder-panel')
  if (panel?.contains(document.activeElement)) document.querySelector('#rec')?.focus()
  stopWaveLoop()
  releasePlayback()
  panelMode = 'closed'
  syncPanelChrome()
  markActiveTake()
}

function restoreRecorderPanel() {
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
  return now + (x - centerX) / pxPerSec
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

function bindWavePointer() {
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

function togglePlayback() {
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
  const url = URL.createObjectURL(take.blob)
  takeUrls.add(url)
  const name = takeFileName(take)
  const when = formatTakeWhen(take.createdAt)
  const iso = new Date(take.createdAt).toISOString()
  const duration = formatTakeDuration(take.durationMs)
  const on = panelMode === 'playback' && playback?.take?.id === take.id
  return `
    <li class="take-row ${on ? 'is-on' : ''}" data-take-id="${take.id}">
      <button class="take-select" type="button" aria-pressed="${on ? 'true' : 'false'}" ${on ? 'aria-current="true"' : ''} aria-label="Select take from ${escapeAttr(when)}, ${escapeAttr(duration)}">
        <span class="take-meta">
          <time datetime="${escapeAttr(iso)}">${escapeHtml(when)}</time>
          <span class="take-duration">${escapeHtml(duration)}</span>
        </span>
        <span class="take-select-gap" aria-hidden="true"></span>
      </button>
      <div class="take-actions">
        <a class="tool mini take-download" href="${escapeAttr(url)}" download="${escapeAttr(name)}" aria-label="Download take" title="Download take">${DOWNLOAD_ICON}</a>
        <button class="tool mini danger" type="button" data-take-delete="${take.id}" aria-label="Delete take from ${escapeAttr(when)}">Delete</button>
      </div>
    </li>`
}

async function renderTakes() {
  const list = document.querySelector('#takes-list')
  if (!list) return
  const key = takeTextKey(current())
  const token = ++takesToken
  let takes = []
  try {
    takes = key ? await listTakes(key) : []
  } catch {
    if (token !== takesToken || !list.isConnected) return
    revokeTakeUrls()
    shownTakes = []
    list.innerHTML = '<li class="empty">Could not load takes.</li>'
    return
  }
  if (token !== takesToken || !list.isConnected || takeTextKey(current()) !== key) return
  try {
    revokeTakeUrls()
    takes.sort((a, b) => b.createdAt - a.createdAt)
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

function commitTake(meta, result) {
  closeAudioGraph()
  syncRecUi()
  if (!result?.blob || !meta?.textKey) {
    leaveRecordingPanel()
    return Promise.resolve(null)
  }
  const exported = exportPeaks()
  return addTake({
    textKey: meta.textKey,
    code: meta.code,
    title: meta.title,
    createdAt: Date.now(),
    durationMs: Math.max(0, Math.round(result.durationMs)),
    mimeType: result.mimeType,
    extension: result.extension,
    blob: result.blob,
  })
    .then(async (saved) => {
      saved.livePeaks = exported.peaks
      saved.livePeakOrigin = exported.origin
      const sameText = takeTextKey(current()) === meta.textKey
      if (sameText) {
        showRecMessage('')
        await renderTakes()
        if (openAfterSave) await openPlayback(saved)
        else leaveRecordingPanel()
      } else leaveRecordingPanel()
      return saved
    })
    .catch((error) => {
      showRecMessage(isIdbQuotaError(error) ? QUOTA_TAKE_MESSAGE : SAVE_TAKE_MESSAGE)
      leaveRecordingPanel()
      return null
    })
}

function stopRecordingAndSave({ openAfter = true } = {}) {
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

async function startRecording() {
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
  if (recWithRun) playRun()
  syncRecUi()
  if (capture.stream) void refreshAudioInputs()
}

function finishRecording(options) {
  if (!capture.isActive()) return Promise.resolve(null)
  const pauseWith = recWithRun
  const task = stopRecordingAndSave(options)
  if (pauseWith) pauseRun()
  return task
}

function toggleRecording() {
  if (capture.isActive()) return finishRecording()
  return startRecording()
}

function pauseRecordingFromPanel() {
  if (capture.phase !== 'recording') return
  if (recWithRun) {
    manualHold = false
    pauseRun()
    return
  }
  manualHold = true
  capture.pause()
  syncRecUi()
}

function resumeRecordingFromPanel() {
  if (capture.phase !== 'paused') return
  manualHold = false
  if (recWithRun) playRun()
  else {
    capture.resume()
    syncRecUi()
  }
}

function onRecWithRunChange(event) {
  recWithRun = Boolean(event.target.checked)
  writeStorage(REC_WITH_RUN_KEY, JSON.stringify(recWithRun))
  syncRecorderToRun()
}

function askConfirm({ title, message }) {
  const dialog = document.querySelector('#confirm-dialog')
  if (!dialog || dialog.open) return Promise.resolve(false)
  const heading = dialog.querySelector('#confirm-heading')
  const copy = dialog.querySelector('#confirm-copy')
  if (heading) heading.textContent = title
  if (copy) copy.textContent = message
  confirmReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  return new Promise((resolve) => {
    confirmResolver = resolve
    dialog.showModal()
    dialog.querySelector('#confirm-cancel')?.focus()
  })
}

async function deleteShownTake(id) {
  const take = shownTakes.find((item) => item.id === id)
  if (!take) return
  const when = formatTakeWhen(take.createdAt)
  const duration = formatTakeDuration(take.durationMs)
  const accepted = await askConfirm({
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

function onTakesClick(event) {
  const del = event.target.closest('[data-take-delete]')
  if (del) {
    const id = Number(del.dataset.takeDelete)
    if (Number.isInteger(id)) void deleteShownTake(id)
    return
  }
  if (event.target.closest('.take-download')) return
  const row = event.target.closest('.take-row')
  if (!row) return
  const id = Number(row.dataset.takeId)
  if (Number.isInteger(id)) void playShownTake(id)
}

function recorderPanelHtml() {
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

function theme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function setTheme(next) {
  if (next === 'dark') document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
  writeStorage(THEME_KEY, JSON.stringify(next))
  const button = document.querySelector('#theme')
  if (button) button.textContent = next === 'dark' ? 'Light' : 'Dark'
  colorCache = { theme: '', ink: '', line: '' }
  if (panelMode === 'recording') paintRecording()
  else if (panelMode === 'playback') paintPlayback()
}

function filtered() {
  const q = state.query.trim().toLowerCase()
  if (!q) return essays.map((essay, index) => ({ essay, index }))
  return essays
    .map((essay, index) => ({ essay, index }))
    .filter(({ essay }) => `${essay.code} ${essay.title}`.toLowerCase().includes(q))
}

function asImportEssay(item, index) {
  const words = `${item.title}\n${item.body}`.split(/\s+/).filter(Boolean).length
  return {
    kind: 'import',
    id: item.id,
    code: `U${index + 1}`,
    file: item.id,
    title: item.title,
    body: item.body,
    words,
    minutes: Math.max(1, Math.round(words / 130)),
    createdAt: item.createdAt,
  }
}

function current() {
  if (state.kind === 'import') {
    const index = imports.findIndex((item) => item.id === state.importId)
    if (index !== -1) return asImportEssay(imports[index], index)
  }
  return essays[state.index]
}

function restoreEssay() {
  const saved = loadJSON(ESSAY_KEY)
  if (!saved || typeof saved !== 'object') return
  if (saved.kind === 'import') {
    const id = typeof saved.id === 'string' ? saved.id : saved.file
    if (typeof id === 'string' && imports.some((item) => item.id === id)) {
      state.kind = 'import'
      state.importId = id
      return
    }
    state.kind = 'essay'
    state.index = 0
    state.importId = null
    return
  }
  const byFile = essays.findIndex((item) => item.file === saved.file)
  if (byFile !== -1) {
    state.kind = 'essay'
    state.index = byFile
    return
  }
  const byCode = essays.findIndex((item) => item.code === saved.code)
  if (byCode !== -1) {
    state.kind = 'essay'
    state.index = byCode
  }
}

function restorePosition() {
  const saved = loadJSON(POSITION_KEY)
  if (!saved || typeof saved !== 'object') return
  const key = itemKey(current())
  if (typeof saved.id === 'string' && saved.id !== key) return
  if (
    Number.isInteger(saved.index) &&
    saved.index >= 0 &&
    saved.index < lineMetrics.length &&
    Number.isFinite(saved.fraction)
  ) {
    const metric = lineMetrics[saved.index]
    restoredAnchor = { index: saved.index, fraction: saved.fraction }
    anchor = { index: saved.index, fraction: saved.fraction, width: -1, height: -1 }
    state.offset = Math.min(offsetCache.max, Math.max(0, offsetForFraction(metric.top, metric.height, saved.fraction)))
    return
  }
  if (Number.isFinite(saved.offset)) {
    state.offset = Math.min(offsetCache.max, Math.max(0, saved.offset))
  }
}

function setLoadError(message) {
  const host = document.querySelector('#sidebar')
  if (!host) return
  let note = host.querySelector('#load-error')
  if (!message) {
    note?.remove()
    return
  }
  if (!note) {
    note = document.createElement('p')
    note.id = 'load-error'
    note.className = 'load-error'
    note.setAttribute('role', 'status')
    host.querySelector('.side-head')?.insertAdjacentElement('afterend', note)
  }
  note.textContent = message
}

async function reloadEssays() {
  setLoadError('')
  try {
    const response = await fetch('/api/essays', { cache: 'no-store' })
    if (!response.ok) throw new Error(`status ${response.status}`)
    const data = await response.json()
    if (!Array.isArray(data)) throw new Error('bad payload')
    const next = data
      .filter((item) => item && typeof item.file === 'string' && typeof item.text === 'string' && isEssayFile(item.file))
      .map((item) => parseEssay(item.file, item.text))
      .sort((a, b) => a.file.localeCompare(b.file))
    const keepImport = state.kind === 'import' && imports.some((item) => item.id === state.importId)
    const currentFile = keepImport ? null : essays[state.index]?.file
    essays = next
    if (keepImport) {
      renderList()
      return
    }
    const found = essays.findIndex((item) => item.file === currentFile)
    if (found === -1) {
      void stopRecordingAndSave()
      state.kind = 'essay'
      state.importId = null
      state.index = 0
      state.offset = 0
      wheelLeft = 0
      state.running = false
      anchor = null
      stopLoop()
    } else {
      state.kind = 'essay'
      state.index = found
    }
    renderList()
    renderSheet()
    const limit = maxOffset()
    if (state.offset > limit) {
      state.offset = limit
      wheelLeft = 0
      applyOffset()
    }
    saveProgressNow()
  } catch {
    setLoadError('Could not reload essays. The list is only available from the dev server.')
  }
}

function selectReading({ kind, index = 0, id = null }) {
  void stopRecordingAndSave({ openAfter: false })
  const prevKey = state.kind === 'import' ? state.importId : essays[state.index]?.file
  const nextKey = kind === 'import' ? id : essays[index]?.file
  const changed = prevKey !== nextKey
  if (changed) closeRecorderPanel()
  state.running = false
  wheelLeft = 0
  stopLoop()
  state.kind = kind
  state.importId = kind === 'import' ? id : null
  if (kind === 'essay') state.index = index
  state.offset = 0
  anchor = null
  setDrawer(false)
  renderList()
  if (changed) renderSheet()
  else {
    applyOffset()
    syncRunButton()
  }
  saveProgressNow()
}

function select(index) {
  if (!Number.isInteger(index) || !essays[index]) return
  selectReading({ kind: 'essay', index })
}

function selectImport(id) {
  if (!imports.some((item) => item.id === id)) return
  selectReading({ kind: 'import', id })
}

function setDrawer(open) {
  state.drawer = open
  document.querySelector('.window')?.classList.toggle('is-drawer', open)
  const menu = document.querySelector('#menu')
  if (menu) menu.setAttribute('aria-expanded', open ? 'true' : 'false')
}

function filteredImports() {
  const q = state.query.trim().toLowerCase()
  return imports
    .map((item, index) => ({ item, index, reading: asImportEssay(item, index) }))
    .filter(({ item, reading }) => !q || `${reading.code} ${reading.title} ${item.body}`.toLowerCase().includes(q))
}

function renderEssayList() {
  const list = filtered()
  const ul = document.querySelector('#essay-list')
  if (!ul) return
  ul.innerHTML = list.length
    ? list
        .map(
          ({ essay: item, index }) => `
        <li>
          <button class="essay ${state.kind !== 'import' && index === state.index ? 'is-on' : ''}" type="button" data-index="${index}">
            <span class="code">${escapeHtml(item.code)}</span>
            <span class="name">${escapeHtml(item.title)}</span>
          </button>
        </li>`,
        )
        .join('')
    : '<li class="empty">No essay matches.</li>'
}

function renderImportList() {
  const ul = document.querySelector('#import-list')
  if (!ul) return
  const list = filteredImports()
  if (!list.length) {
    ul.innerHTML = `<li class="empty">${state.query.trim() ? 'No text matches.' : 'Nothing imported yet.'}</li>`
    return
  }
  ul.innerHTML = list
    .map(({ item, reading }) => {
      const on = state.kind === 'import' && state.importId === item.id
      return `
        <li class="import-row">
          <button class="essay ${on ? 'is-on' : ''}" type="button" data-import-id="${escapeAttr(item.id)}">
            <span class="code">${escapeHtml(reading.code)}</span>
            <span class="name">${escapeHtml(item.title)}</span>
          </button>
          <div class="import-tools">
            <button class="tool mini" type="button" data-edit="${escapeAttr(item.id)}" aria-label="Edit ${escapeAttr(item.title)}">Edit</button>
            <button class="tool mini danger" type="button" data-delete="${escapeAttr(item.id)}" aria-label="Delete ${escapeAttr(item.title)}">Delete</button>
          </div>
        </li>`
    })
    .join('')
}

function renderList() {
  renderEssayList()
  renderImportList()
}

function showDialogError(message) {
  const note = document.querySelector('#import-error')
  if (!note) return
  note.hidden = false
  note.textContent = message
}

function clearDialogError() {
  const note = document.querySelector('#import-error')
  if (!note) return
  note.hidden = true
  note.textContent = ''
}

function showImportNote(message) {
  const note = document.querySelector('#import-note')
  if (!note) return
  note.hidden = false
  note.textContent = message
}

function clearImportNote() {
  const note = document.querySelector('#import-note')
  if (!note) return
  note.hidden = true
  note.textContent = ''
}

function addImport(raw, options) {
  const parsed = parseImportedText(raw, options)
  if (parsed.error) return parsed
  const item = {
    id: newImportId(),
    title: parsed.title,
    body: parsed.body,
    createdAt: new Date().toISOString(),
  }
  const next = [...imports, item]
  const saved = writeImports(next)
  if (!saved.ok) return { error: saved.quota ? QUOTA_IMPORT_MESSAGE : 'Could not save this text.' }
  imports = next
  clearImportNote()
  return { item }
}

function validateImportBody(raw, { fileName = '', markdown = false } = {}) {
  if (typeof raw !== 'string') return { error: EMPTY_IMPORT_MESSAGE }
  if (textBytes(raw) > MAX_IMPORT_BYTES) return { error: SIZE_IMPORT_MESSAGE }
  let text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (markdown || isMarkdownName(fileName)) text = stripMarkdownHeadings(text)
  text = text.trim()
  if (!text) return { error: EMPTY_IMPORT_MESSAGE }
  return { text }
}

function fallbackTitle(text, fileName) {
  const gap = text.indexOf('\n\n')
  const titleBlock = gap === -1 ? text : text.slice(0, gap)
  let finalTitle = ''
  if (gap !== -1) finalTitle = titleCase(titleBlock)
  else if (prettyFileName(fileName)) finalTitle = prettyFileName(fileName)
  else {
    const firstLine = text.split('\n').find((line) => line.trim())?.trim() ?? ''
    finalTitle = firstLine ? titleCase(firstLine) : ''
  }
  finalTitle = clampTitle(finalTitle)
  if (!finalTitle) finalTitle = prettyFileName(fileName) || 'Untitled'
  return finalTitle
}

function capturedReadingPlace() {
  const index = activeIndex >= 0 ? activeIndex : anchor?.index ?? 0
  const fraction = anchor && anchor.index === index && Number.isFinite(anchor.fraction) ? anchor.fraction : 0
  return { index: Math.max(0, index), fraction }
}

function placeReading(index, fraction) {
  anchor = { index, fraction, width: -1, height: -1 }
}

function updateImport(id, titleValue, bodyValue) {
  const existing = imports.find((item) => item.id === id)
  if (!existing) return { error: 'Could not save this text.' }
  const validated = validateImportBody(bodyValue, { fileName: importFileName, markdown: importMarkdown })
  if (validated.error) return validated
  // An untouched textarea must round-trip the stored body exactly, even when
  // normalization would otherwise rewrite whitespace.
  const body = bodyValue === existing.body || validated.text === existing.body ? existing.body : validated.text
  const title = clampTitle(titleValue) || fallbackTitle(body, importFileName)
  const nextItem = {
    id: existing.id,
    title,
    body,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  }
  const next = imports.map((item) => (item.id === id ? nextItem : item))
  const saved = writeImports(next)
  if (!saved.ok) return { error: saved.quota ? QUOTA_IMPORT_MESSAGE : 'Could not save this text.' }
  const bodyChanged = body !== existing.body
  const place = capturedReadingPlace()
  imports = next
  clearImportNote()
  renderImportList()
  if (state.kind === 'import' && state.importId === id) {
    if (bodyChanged) {
      const lines = scriptLineCount(body)
      if (lines <= 0) {
        anchor = null
        state.offset = 0
      } else {
        // Keep the current line index, clamped to the new script.
        placeReading(Math.min(place.index, lines - 1), place.fraction)
      }
    } else {
      placeReading(place.index, place.fraction)
    }
    renderSheet()
    saveProgressNow()
  }
  return { item: nextItem }
}

async function deleteImport(id) {
  const item = imports.find((entry) => entry.id === id)
  if (!item) return
  const accepted = await askConfirm({
    title: 'Delete text?',
    message: `Delete "${item.title}"?`,
  })
  if (!accepted) return
  const next = imports.filter((entry) => entry.id !== id)
  const saved = writeImports(next)
  if (!saved.ok) {
    showImportNote(saved.quota ? QUOTA_IMPORT_MESSAGE : 'Could not delete this text.')
    return
  }
  imports = next
  clearImportNote()
  if (state.kind === 'import' && state.importId === id) {
    if (essays.length) select(0)
    else {
      void stopRecordingAndSave()
      state.kind = 'essay'
      state.index = 0
      state.importId = null
      state.offset = 0
      anchor = null
      state.running = false
      wheelLeft = 0
      stopLoop()
      renderList()
      renderSheet()
      saveProgressNow()
    }
    return
  }
  renderImportList()
}

function setDialogMode(mode) {
  const heading = document.querySelector('#import-heading')
  const save = document.querySelector('#import-save')
  if (heading) heading.textContent = mode === 'edit' ? 'Edit text' : 'Import text'
  if (save) save.textContent = mode === 'edit' ? 'Save' : 'Import'
}

function openImportDialog() {
  const dialog = document.querySelector('#import-dialog')
  if (!dialog || dialog.open) return
  importReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : document.querySelector('#import-open')
  editingId = null
  importFileName = ''
  importMarkdown = false
  dialog.querySelector('form')?.reset()
  clearDialogError()
  setDialogMode('import')
  dialog.showModal()
  dialog.querySelector('#import-name')?.focus()
}

function openEditDialog(id) {
  const dialog = document.querySelector('#import-dialog')
  const item = imports.find((entry) => entry.id === id)
  if (!dialog || dialog.open || !item) return
  importReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  editingId = item.id
  importFileName = ''
  importMarkdown = false
  dialog.querySelector('form')?.reset()
  clearDialogError()
  const name = dialog.querySelector('#import-name')
  const body = dialog.querySelector('#import-body')
  if (name) name.value = item.title
  if (body) body.value = item.body
  setDialogMode('edit')
  dialog.showModal()
  name?.focus()
}

function dialogFocusables(dialog) {
  return [...dialog.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((el) => {
    if (el.disabled || el.getAttribute('aria-hidden') === 'true' || el.closest('[hidden]')) return false
    return true
  })
}

async function importDroppedFile(file) {
  if (!file || !isTextFileName(file.name)) {
    openImportDialog()
    showDialogError(TYPE_IMPORT_MESSAGE)
    return
  }
  if (file.size > MAX_IMPORT_BYTES) {
    openImportDialog()
    showDialogError(SIZE_IMPORT_MESSAGE)
    return
  }
  let text = ''
  try {
    text = await readTextFile(file)
  } catch {
    openImportDialog()
    showDialogError(READ_IMPORT_MESSAGE)
    return
  }
  const result = addImport(text, { fileName: file.name, markdown: isMarkdownName(file.name) })
  if (result.error) {
    openImportDialog()
    showDialogError(result.error)
    return
  }
  document.querySelector('#import-dialog')?.close()
  selectImport(result.item.id)
}

function isFileDrag(event) {
  const types = event.dataTransfer?.types
  if (!types) return false
  return [...types].includes('Files')
}

function filesFromTransfer(transfer) {
  const fromList = [...(transfer?.files ?? [])]
  if (fromList.length) return fromList
  return [...(transfer?.items ?? [])]
    .map((item) => (item.kind === 'file' ? item.getAsFile() : null))
    .filter(Boolean)
}

function applyFontSize(next) {
  const size = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(Number(next))))
  if (!Number.isInteger(size)) return
  state.fontSize = size
  writeStorage(FONT_KEY, JSON.stringify(size))
  document.documentElement.style.setProperty('--script-size', `${size}px`)
  const label = document.querySelector('#font-size-value')
  if (label) label.textContent = String(size)
  const input = document.querySelector('#font-size')
  if (input && Number(input.value) !== size) input.value = String(size)
  if (anchor) anchor = { index: anchor.index, fraction: anchor.fraction, width: -1, height: -1 }
  measure()
  applyOffset()
  scheduleSave()
}

function frameEl() {
  return document.querySelector('#stage-frame')
}

function syncFullscreenButton() {
  const button = document.querySelector('#fullscreen')
  const frame = frameEl()
  if (!button || !frame) return
  const on = frame.classList.contains('is-fullscreen')
  button.setAttribute('aria-pressed', on ? 'true' : 'false')
  button.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen')
  button.innerHTML = on ? EXIT_ICON : ENTER_ICON
}

function setFullscreenMode(on) {
  const frame = frameEl()
  if (!frame) return
  frame.classList.toggle('is-fullscreen', on)
  document.documentElement.classList.toggle('is-reading-fullscreen', on)
  syncFullscreenButton()
  if (anchor) anchor = { index: anchor.index, fraction: anchor.fraction, width: -1, height: -1 }
  measure()
  applyOffset()
  if (panelMode === 'recording') paintRecording()
  else if (panelMode === 'playback') paintPlayback()
}

async function toggleFullscreen() {
  const frame = frameEl()
  if (!frame) return
  const wasOn = document.fullscreenElement === frame || frame.classList.contains('is-fullscreen')
  try {
    if (document.fullscreenElement === frame) await document.exitFullscreen()
    else if (!wasOn) await frame.requestFullscreen()
  } catch {
    /* Headless Chrome and browsers without a display reject the Fullscreen API. */
  }
  if (wasOn) setFullscreenMode(document.fullscreenElement === frame)
  else setFullscreenMode(document.fullscreenElement === frame || document.fullscreenElement == null)
}

function bindSheet() {
  document.querySelector('#run')?.addEventListener('click', toggleRun)
  document.querySelector('#rec')?.addEventListener('click', () => {
    void toggleRecording()
  })
  document.querySelector('#rec-stage')?.addEventListener('click', () => {
    void toggleRecording()
  })
  document.querySelector('#rec-with-run')?.addEventListener('change', onRecWithRunChange)
  document.querySelector('#mic-idle')?.addEventListener('change', onMicChange)
  document.querySelector('#recorder-mic')?.addEventListener('change', onMicChange)
  renderMicSelects()
  document.querySelector('#recorder-stop')?.addEventListener('click', () => {
    void finishRecording()
  })
  document.querySelector('#recorder-pause')?.addEventListener('click', () => {
    if (capture.phase === 'paused') resumeRecordingFromPanel()
    else pauseRecordingFromPanel()
  })
  document.querySelector('#recorder-play')?.addEventListener('click', () => {
    togglePlayback()
  })
  document.querySelector('#recorder-close')?.addEventListener('click', () => {
    closeRecorderPanel()
  })
  bindWavePointer()
  document.querySelector('#to-top')?.addEventListener('click', toTop)
  document.querySelector('#fullscreen')?.addEventListener('click', () => {
    toggleFullscreen()
  })
  document.querySelector('#speed')?.addEventListener('input', (event) => {
    const next = Number(event.target.value)
    state.speed = next
    writeStorage(SPEED_KEY, JSON.stringify(next))
    const label = document.querySelector('#speed-value')
    if (label) label.textContent = String(next)
    updateProgress()
  })
  document.querySelector('#font-size')?.addEventListener('input', (event) => {
    applyFontSize(event.target.value)
  })
  document.querySelector('#text-view')?.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      scrollBy(wheelDistance(event))
    },
    { passive: false },
  )
}

function renderSheet() {
  const sheet = document.querySelector('.sheet')
  const essay = current()
  activeIndex = -1
  resizeObserver.disconnect()
  if (!sheet) return
  if (!essay) {
    lineNodes = []
    lineMetrics = []
    offsetCache = { width: 0, height: 0, focusShift: 0, max: 0 }
    sheet.innerHTML = '<p class="empty">No essays found. Add an E01-....txt file next to this reader.</p>'
    void renderTakes()
    return
  }
  sheet.innerHTML = `
    <div class="head">
      <p class="kicker">${escapeHtml(essay.code)} · ${essay.words} words · ${essay.minutes} min</p>
      <h1>${escapeHtml(essay.title)}</h1>
    </div>
    <div class="read">
      <div class="transport">
        <button class="btn ${state.running ? '' : 'btn-next'}" id="run" type="button" aria-pressed="${state.running ? 'true' : 'false'}">${state.running ? 'Pause' : 'Run'}</button>
        <button class="btn rec" id="rec" type="button" aria-pressed="false" aria-label="Start recording">
          <span class="rec-dot" aria-hidden="true"></span>
          <span>Rec</span>
        </button>
        <label class="rec-with-run">
          <input id="rec-with-run" type="checkbox" ${recWithRun ? 'checked' : ''} />
          Start scrolling with recording
        </label>
        <div class="sliders">
          <label class="speed">
            Speed
            <input id="speed" type="range" min="1" max="50" step="1" value="${state.speed}" aria-label="Speed" />
            <span id="speed-value">${state.speed}</span>
          </label>
          <label class="font-size">
            Size
            <input id="font-size" type="range" min="${FONT_MIN}" max="${FONT_MAX}" step="1" value="${state.fontSize}" aria-label="Font size" />
            <span id="font-size-value">${state.fontSize}</span>
          </label>
        </div>
        <p class="rec-message" data-rec-message role="alert" hidden></p>
      </div>
      <div class="mic-row" id="mic-row">
        ${MIC_ICON}
        <select class="mic-select" id="mic-idle" aria-label="Microphone"></select>
      </div>
      <div class="stage-frame" id="stage-frame">
      ${recorderPanelHtml()}
      <div class="stage" id="text-view">
        <p class="rec-message rec-stage-message" data-rec-message role="alert" hidden></p>
        <button class="btn rec rec-stage" id="rec-stage" type="button" aria-pressed="false" aria-label="Start recording">
          <span class="rec-dot" aria-hidden="true"></span>
          <span>Rec</span>
        </button>
        <div class="guide" aria-hidden="true"></div>
        <div class="script" id="text-script">${renderLines(essay.body)}</div>
        <div class="progress">
          <div class="progress-track">
            <div class="progress-bar" id="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Reading progress"></div>
          </div>
          <span id="progress-time">0:00 left</span>
        </div>
        <button class="btn fullscreen" id="fullscreen" type="button" aria-pressed="false" aria-label="Enter fullscreen">${ENTER_ICON}</button>
        <button class="btn to-top" id="to-top" type="button" aria-label="To the top">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 19V6" />
            <path d="M6 11l6-6 6 6" />
          </svg>
        </button>
      </div>
      </div>
    </div>`
  bindSheet()
  resetRulerTrack()
  syncRecUi()
  watchRecorderSize()
  restoreRecorderPanel()
  void renderTakes()
  const view = document.querySelector('#text-view')
  if (view) resizeObserver.observe(view)
  measure()
  if (needsRestore) {
    needsRestore = false
    restorePosition()
  }
  applyOffset()
  if (state.running) startLoop()
}

function mount() {
  app.innerHTML = `
    <div class="window">
      <header class="topbar">
        <button class="menu" id="menu" type="button" aria-label="Essays" aria-controls="sidebar" aria-expanded="false">Menu</button>
        <div class="brand">Teleprompter</div>
        <label class="search">
          <span class="sr">Search essays and texts</span>
          <input id="search" type="search" placeholder="Search" value="${escapeAttr(state.query)}" />
        </label>
        <button class="tool" id="theme" type="button">${theme() === 'dark' ? 'Light' : 'Dark'}</button>
      </header>
      <div class="body">
        <aside class="sidebar" id="sidebar">
          <div class="side-head">
            <p class="side-label">Essays</p>
            ${
              import.meta.env.DEV
                ? `<button class="tool reload" id="reload" type="button" aria-label="Reload essays">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-2.6-6.3" />
                <path d="M21 4v5h-5" />
              </svg>
            </button>`
                : ''
            }
          </div>
          <ul id="essay-list"></ul>
          <div class="side-head imports-head">
            <p class="side-label" id="imports-label">My texts</p>
            <button class="tool" id="import-open" type="button">Import</button>
          </div>
          <p id="import-note" class="load-error" role="status" hidden></p>
          <ul id="import-list" aria-labelledby="imports-label"></ul>
          <div class="side-head takes-head">
            <p class="side-label" id="takes-label">Takes</p>
          </div>
          <ul id="takes-list" aria-labelledby="takes-label"></ul>
        </aside>
        <button class="backdrop" id="backdrop" type="button" aria-label="Close menu"></button>
        <main class="sheet"></main>
      </div>
    </div>
    <dialog class="import-dialog" id="import-dialog" aria-labelledby="import-heading">
      <form class="import-form" id="import-form">
        <div class="import-head">
          <h2 id="import-heading">Import text</h2>
        </div>
        <label class="field">Title
          <input id="import-name" type="text" maxlength="180" autocomplete="off" placeholder="Leave blank to use the first line" />
        </label>
        <label class="field">Text
          <textarea id="import-body" rows="10" placeholder="Paste text here"></textarea>
        </label>
        <label class="field">File
          <input id="import-file" type="file" accept=".txt,.md,text/plain,text/markdown" />
        </label>
        <p class="hint">.txt or .md, UTF-8, up to 200 KB. You can also drop a file on the window.</p>
        <p id="import-error" class="import-error" role="alert" hidden></p>
        <div class="dialog-actions">
          <button class="btn" id="import-cancel" type="button">Cancel</button>
          <button class="btn btn-next" id="import-save" type="submit">Import</button>
        </div>
      </form>
    </dialog>
    <dialog class="import-dialog confirm-dialog" id="confirm-dialog" aria-labelledby="confirm-heading" aria-describedby="confirm-copy">
      <div class="import-form">
        <div class="import-head">
          <h2 id="confirm-heading">Delete take?</h2>
        </div>
        <p class="confirm-copy" id="confirm-copy"></p>
        <div class="dialog-actions">
          <button class="btn" id="confirm-cancel" type="button">Cancel</button>
          <button class="btn danger" id="confirm-delete" type="button">Delete</button>
        </div>
      </div>
    </dialog>
  `
  document.querySelector('#reload')?.addEventListener('click', () => {
    reloadEssays()
  })
  document.querySelector('#theme').addEventListener('click', () => {
    setTheme(theme() === 'dark' ? 'light' : 'dark')
  })
  document.querySelector('#menu').addEventListener('click', () => {
    setDrawer(!state.drawer)
  })
  document.querySelector('#backdrop').addEventListener('click', () => {
    setDrawer(false)
  })
  document.querySelector('#essay-list').addEventListener('click', (event) => {
    const button = event.target.closest('.essay')
    if (!button) return
    select(Number(button.dataset.index))
  })
  document.querySelector('#import-open').addEventListener('click', openImportDialog)
  const importList = document.querySelector('#import-list')
  importList.addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit]')
    if (edit) {
      openEditDialog(edit.dataset.edit)
      return
    }
    const del = event.target.closest('[data-delete]')
    if (del) {
      deleteImport(del.dataset.delete)
      return
    }
    const button = event.target.closest('[data-import-id]')
    if (button) selectImport(button.dataset.importId)
  })
  document.querySelector('#takes-list')?.addEventListener('click', onTakesClick)
  const confirmDialog = document.querySelector('#confirm-dialog')
  const confirmCancel = confirmDialog.querySelector('#confirm-cancel')
  const confirmDelete = confirmDialog.querySelector('#confirm-delete')
  confirmDialog.addEventListener('close', () => {
    const resolve = confirmResolver
    confirmResolver = null
    const back = confirmReturnFocus
    confirmReturnFocus = null
    resolve?.(false)
    if (back?.isConnected) back.focus()
  })
  confirmDialog.addEventListener('click', (event) => {
    if (event.target === confirmDialog) confirmDialog.close()
  })
  confirmDialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      return
    }
    if (event.key === 'Enter') {
      if (event.target === confirmDelete) return
      event.preventDefault()
      if (event.target === confirmCancel) confirmDialog.close()
      return
    }
    if (event.key !== 'Tab') return
    const nodes = dialogFocusables(confirmDialog)
    if (!nodes.length) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !confirmDialog.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !confirmDialog.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  })
  confirmCancel.addEventListener('click', () => confirmDialog.close())
  confirmDelete.addEventListener('click', () => {
    const resolve = confirmResolver
    confirmResolver = null
    confirmDialog.close()
    resolve?.(true)
  })
  const dialog = document.querySelector('#import-dialog')
  const importForm = document.querySelector('#import-form')
  dialog.addEventListener('close', () => {
    editingId = null
    importFileName = ''
    importMarkdown = false
    dialog.querySelector('form')?.reset()
    clearDialogError()
    setDialogMode('import')
    const back = importReturnFocus
    importReturnFocus = null
    if (back?.isConnected) back.focus()
    else document.querySelector('#import-open')?.focus()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      return
    }
    if (event.key !== 'Tab') return
    const nodes = dialogFocusables(dialog)
    if (!nodes.length) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  })
  document.querySelector('#import-cancel').addEventListener('click', () => dialog.close())
  importForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const title = document.querySelector('#import-name')?.value ?? ''
    const body = document.querySelector('#import-body')?.value ?? ''
    const id = editingId
    const result = id
      ? updateImport(id, title, body)
      : addImport(body, { title, fileName: importFileName, markdown: importMarkdown })
    if (result.error) {
      showDialogError(result.error)
      return
    }
    dialog.close()
    if (!id) selectImport(result.item.id)
  })
  document.querySelector('#import-file')?.addEventListener('change', async (event) => {
    const input = event.target
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (!isTextFileName(file.name)) {
      showDialogError(TYPE_IMPORT_MESSAGE)
      return
    }
    if (file.size > MAX_IMPORT_BYTES) {
      showDialogError(SIZE_IMPORT_MESSAGE)
      return
    }
    try {
      const text = await readTextFile(file)
      if (textBytes(text) > MAX_IMPORT_BYTES) {
        showDialogError(SIZE_IMPORT_MESSAGE)
        return
      }
      const box = document.querySelector('#import-body')
      if (box) box.value = text
      importFileName = file.name
      importMarkdown = isMarkdownName(file.name)
      clearDialogError()
    } catch {
      showDialogError(READ_IMPORT_MESSAGE)
    }
  })
  let dragDepth = 0
  app.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepth += 1
    app.classList.add('is-file-drop')
  })
  app.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  })
  app.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) app.classList.remove('is-file-drop')
  })
  app.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepth = 0
    app.classList.remove('is-file-drop')
    const dropped = filesFromTransfer(event.dataTransfer)
    const file = dropped.find((item) => isTextFileName(item.name))
    importDroppedFile(file || dropped[0])
  })
  const search = document.querySelector('#search')
  search.addEventListener('input', () => {
    state.query = search.value
    renderList()
  })
  renderList()
  renderSheet()
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeAttr(value) {
  return escapeHtml(value)
}

readStorage(THEME_KEY)
restoreEssay()
void warmRecordingStore()
document.documentElement.style.setProperty('--script-size', `${state.fontSize}px`)
mount()
void refreshAudioInputs()
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  void refreshAudioInputs()
})

if (document.fonts?.ready) {
  document.fonts.ready.then(() => {
    const saved = restoredAnchor || (anchor && { index: anchor.index, fraction: anchor.fraction })
    restoredAnchor = null
    measure()
    if (saved && Number.isInteger(saved.index)) {
      anchor = { index: saved.index, fraction: saved.fraction, width: -1, height: -1 }
    }
    applyOffset()
  })
}

function onPageLeave() {
  saveProgressNow()
  if (capture.isActive()) void stopRecordingAndSave()
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') onPageLeave()
})
window.addEventListener('pagehide', onPageLeave)
window.addEventListener('beforeunload', onPageLeave)

document.addEventListener('fullscreenchange', () => {
  const frame = frameEl()
  setFullscreenMode(!!frame && document.fullscreenElement === frame)
})

function isTypingTarget(target) {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable ||
    (target instanceof HTMLInputElement && ['search', 'text'].includes(target.type))
  )
}

document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open]')) return
  const typing = isTypingTarget(event.target)
  if (event.key === 'Escape') {
    const frame = frameEl()
    if (frame?.classList.contains('is-fullscreen') && document.fullscreenElement !== frame) setFullscreenMode(false)
    return
  }
  if (event.key === ' ') {
    if (typing) return
    if (event.target instanceof Element && event.target.closest('.take-select, .take-download, [data-take-delete]')) return
    event.preventDefault()
    if (!event.repeat) toggleRun()
    return
  }
  const plain = !typing && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey
  if ((event.key === 'f' || event.key === 'F') && plain) {
    event.preventDefault()
    toggleFullscreen()
    return
  }
  if ((event.key === 'r' || event.key === 'R') && plain) {
    event.preventDefault()
    void toggleRecording()
  }
})
