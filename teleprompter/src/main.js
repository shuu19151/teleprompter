import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/literata/latin-400.css'
import '@fontsource/literata/latin-700.css'
import './style.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  currentReading,
  essayIndexByFile,
  essayStorageRecord,
  filterEssays,
  filterImports,
  itemKey,
  openTextKey,
  positionApplies,
  positionStorageRecord,
  resolveSelection,
} from './content-selection.js'
import { isEssayFile } from './essay-files.js'
import {
  clearSavedFolder,
  deleteEssayFile,
  folderPermission,
  folderPickerSupported,
  inTauri,
  isFolderScopeError,
  loadSavedFolder,
  pickEssayFolder,
  readEssayFiles,
  requestFolderPermission,
  revealEssayFile,
  saveFolderHandle,
} from './essay-folder.js'
import { elementFromEvent, openRowMenu } from './row-menu.js'
import {
  clampTitle,
  EMPTY_IMPORT_MESSAGE,
  isMarkdownName,
  isQuotaError,
  isTextFileName,
  loadImports,
  MAX_IMPORT_BYTES,
  newImportId,
  parseEssay,
  parseImportedText,
  prettyFileName,
  readTextFile,
  SIZE_IMPORT_MESSAGE,
  textBytes,
  titleCase,
  writeImports,
} from './text-import.js'
import { warmRecordingStore } from './recording.js'
import { bridge } from './ui-bridge.js'
import {
  bindWavePointer,
  closeRecorderPanel,
  finishRecording,
  isRecWithRun,
  onMicChange,
  onRecWithRunChange,
  onTakesClick,
  onTakesContextMenu,
  onTakesMenuKey,
  onVoiceEnhanceChange,
  paintPlayback,
  paintRecording,
  pauseRecordingFromPanel,
  recorderMode,
  recorderPaused,
  recorderPanelHtml,
  recordingActive,
  refreshAudioInputs,
  renderMicSelects,
  renderTakes,
  resetRulerTrack,
  restoreRecorderPanel,
  resumeRecordingFromPanel,
  showRecMessage,
  stopRecordingAndSave,
  syncRecUi,
  syncRecorderToRun,
  togglePlayback,
  toggleRecording,
  voiceEnhanceControl,
} from './recorder-ui.js'

const THEME_KEY = 'teleprompter:theme'
const SPEED_KEY = 'teleprompter:speed'
const ESSAY_KEY = 'teleprompter:essay'
const POSITION_KEY = 'teleprompter:position'
const FONT_KEY = 'teleprompter:fontSize'
const IMPORTS_KEY = 'teleprompter:imports'
const FONT_MIN = 24
const FONT_MAX = 56
const FONT_DEFAULT = 32
const READING_RATIO = 1 / 3
const SAVE_DELAY = 300
const TYPE_IMPORT_MESSAGE = 'Choose a .txt or .md file.'
const READ_IMPORT_MESSAGE = 'Could not read that file.'
const QUOTA_IMPORT_MESSAGE = 'Could not save this text because browser storage is full.'
const ENTER_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H4v4"/><path d="M16 4h4v4"/><path d="M4 16v4h4"/><path d="M20 16v4h-4"/></svg>`
const EXIT_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M4 15h5v5"/><path d="M20 15h-5v5"/></svg>`
const MIC_ICON = `<svg class="mic-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M8.5 21h7"/></svg>`
const FOLDER_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h5l2 2h9v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 7V6a1 1 0 0 1 1-1h4l2 2"/></svg>`
const LEGACY_KEYS = {
  [THEME_KEY]: 'office-essay:theme',
  [SPEED_KEY]: 'office-essay:speed',
}

// Case-sensitive E*.txt, matching isEssayFile and /api/essays.
const files = import.meta.glob('../../essays/E*.txt', { query: '?raw', import: 'default', eager: true })

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

function essaysFromGlob() {
  return Object.entries(files)
    .filter(([path]) => isEssayFile(path))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, raw]) => parseEssay(path, raw))
}

const bundledEssays = essaysFromGlob()
let essays = bundledEssays
let folderHandle = null
let folderName = ''
let folderNeedsGesture = false
let folderBootMessage = ''

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
      if (recorderMode() === 'recording') paintRecording()
      else if (recorderMode() === 'playback') paintPlayback()
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

function saveProgress() {
  const essay = current()
  if (!essay) return
  const record = essayStorageRecord(essay)
  writeStorage(ESSAY_KEY, JSON.stringify(record))
  const metric = lineMetrics[activeIndex]
  if (metric && offsetCache.height) {
    const fraction = fractionAtOffset(metric.top, metric.height)
    writeStorage(
      POSITION_KEY,
      JSON.stringify(positionStorageRecord({ index: activeIndex, fraction, id: record.id, useLine: true })),
    )
    return
  }
  writeStorage(POSITION_KEY, JSON.stringify(positionStorageRecord({ offset: state.offset, id: record.id })))
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
      // The last line stops the scroll only. Recording keeps going until Stop.
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
  if (recorderMode() === 'recording') paintRecording()
  else if (recorderMode() === 'playback') paintPlayback()
}

function filtered() {
  return filterEssays(essays, state.query)
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

function current() {
  return currentReading({
    kind: state.kind,
    index: state.index,
    importId: state.importId,
    essays,
    imports,
  })
}

function restoreEssay() {
  const next = resolveSelection({ savedSelection: loadJSON(ESSAY_KEY), essays, imports })
  if (!next) return
  state.kind = next.kind
  if (next.index !== undefined) state.index = next.index
  if (Object.prototype.hasOwnProperty.call(next, 'importId')) state.importId = next.importId
}

function restorePosition() {
  const saved = loadJSON(POSITION_KEY)
  if (!positionApplies(saved, itemKey(current()))) return
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

let noticeTimer = 0
let noticeHideTimer = 0

function hideNotice(note) {
  note.hidden = true
  note.textContent = ''
  note.classList.remove('is-in', 'is-out')
}

function showNotice(message) {
  const text = typeof message === 'string' ? message.trim() : ''
  if (!text) return
  let note = document.querySelector('#notice')
  if (!note) {
    note = document.createElement('p')
    note.id = 'notice'
    note.className = 'notice'
    note.setAttribute('role', 'status')
    document.body.appendChild(note)
  }
  window.clearTimeout(noticeTimer)
  window.clearTimeout(noticeHideTimer)
  note.textContent = text
  note.hidden = false
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) {
    note.classList.remove('is-out')
    note.classList.add('is-in')
    noticeTimer = window.setTimeout(() => hideNotice(note), 2000)
    return
  }
  const fadingOut = note.classList.contains('is-out')
  note.classList.remove('is-out')
  if (!note.classList.contains('is-in') || fadingOut) {
    if (!fadingOut) note.classList.remove('is-in')
    void note.offsetWidth
    note.classList.add('is-in')
  }
  noticeTimer = window.setTimeout(() => {
    note.classList.remove('is-in')
    note.classList.add('is-out')
    noticeHideTimer = window.setTimeout(() => hideNotice(note), 700)
  }, 2200)
}

function setLoadError(message) {
  const note = document.querySelector('#load-error')
  if (!note) return
  if (!message) {
    note.hidden = true
    note.textContent = ''
    return
  }
  note.hidden = false
  note.textContent = message
}

function updateFolderChrome() {
  const reload = document.querySelector('#reload')
  if (reload) reload.hidden = !(import.meta.env.DEV || folderHandle)
  const name = document.querySelector('#folder-name')
  if (name) {
    name.hidden = !folderName
    name.textContent = folderName
    name.title = folderName
  }
  const reset = document.querySelector('#use-app-essays')
  if (reset) reset.hidden = !folderHandle
  if (folderNeedsGesture) {
    const control = folderHandle?.path ? 'Folder' : 'reload'
    setLoadError(
      folderName ? `Click ${control} to allow reading ${folderName}.` : `Click ${control} to allow reading this folder.`,
    )
  } else if (folderBootMessage) {
    setLoadError(folderBootMessage)
    folderBootMessage = ''
  }
}

function applyEssayList(next) {
  const keepImport = state.kind === 'import' && imports.some((item) => item.id === state.importId)
  const currentFile = keepImport ? null : essays[state.index]?.file
  essays = next
  updateFolderChrome()
  if (keepImport) {
    renderList()
    return
  }
  // No essay was on screen (the chosen folder was still waiting for a click).
  // Open the saved essay in this list, including its saved line.
  if (!currentFile) {
    void stopRecordingAndSave()
    state.running = false
    wheelLeft = 0
    stopLoop()
    state.kind = 'essay'
    state.importId = null
    state.index = 0
    state.offset = 0
    anchor = null
    restoreEssay()
    renderList()
    renderSheet()
    restorePosition()
    applyOffset()
    saveProgressNow()
    return
  }
  const found = essayIndexByFile(essays, currentFile)
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
}

async function essaysFromHandle(handle) {
  const data = await readEssayFiles(handle)
  return data.map((item) => parseEssay(item.file, item.text))
}

async function adoptSavedFolder() {
  if (!folderPickerSupported()) return
  const handle = await loadSavedFolder()
  if (!handle) return
  folderHandle = handle
  folderName = handle.name || 'Folder'
  const permission = await folderPermission(handle)
  if (permission === 'prompt') {
    folderNeedsGesture = true
    essays = []
    return
  }
  if (permission !== 'granted') {
    essays = []
    folderBootMessage = 'Could not read that folder.'
    return
  }
  try {
    essays = await essaysFromHandle(handle)
    folderNeedsGesture = false
  } catch {
    essays = []
    folderBootMessage = 'Could not read that folder.'
  }
}

async function reloadEssays() {
  setLoadError('')
  if (folderHandle) {
    try {
      let permission = await folderPermission(folderHandle)
      if (permission !== 'granted' && !folderHandle.path) permission = await requestFolderPermission(folderHandle)
      if (permission === 'missing') {
        setLoadError('Could not read that folder.')
        return
      }
      if (permission !== 'granted') {
        folderNeedsGesture = true
        updateFolderChrome()
        return
      }
      folderNeedsGesture = false
      applyEssayList(await essaysFromHandle(folderHandle))
    } catch {
      setLoadError('Could not read that folder.')
    }
    return
  }
  try {
    const response = await fetch('/api/essays', { cache: 'no-store' })
    if (!response.ok) throw new Error(`status ${response.status}`)
    const data = await response.json()
    if (!Array.isArray(data)) throw new Error('bad payload')
    const next = data
      .filter((item) => item && typeof item.file === 'string' && typeof item.text === 'string' && isEssayFile(item.file))
      .map((item) => parseEssay(item.file, item.text))
      .sort((a, b) => a.file.localeCompare(b.file))
    applyEssayList(next)
  } catch {
    setLoadError('Could not reload essays. The list is only available from the dev server.')
  }
}

async function chooseFolder() {
  if (!folderPickerSupported()) {
    setLoadError('This browser cannot open a folder. Use Chrome or Edge at http://127.0.0.1:5173.')
    return
  }
  let handle
  try {
    handle = await pickEssayFolder(folderHandle?.path)
  } catch (error) {
    if (error?.name === 'AbortError') return
    setLoadError('Could not open that folder.')
    return
  }
  folderHandle = handle
  folderName = handle.name || 'Folder'
  folderNeedsGesture = false
  let rememberError = false
  try {
    await saveFolderHandle(handle)
  } catch {
    rememberError = true
  }
  try {
    applyEssayList(await essaysFromHandle(handle))
    setLoadError(rememberError ? 'Could not remember this folder in this browser.' : '')
  } catch {
    setLoadError('Could not read that folder.')
    updateFolderChrome()
  }
}

function openEssayMenu(button, x, y) {
  const index = Number(button.dataset.index)
  const essay = Number.isInteger(index) ? essays[index] : null
  if (!essay) return
  const items = [{ label: 'Open', onSelect: () => select(index) }]
  if (folderHandle?.path && inTauri()) {
    items.push({
      label: 'Show in folder',
      onSelect: () => {
        void showEssayInFolder(essay)
      },
    })
  }
  if (folderHandle) {
    items.push({
      label: 'Delete',
      danger: true,
      onSelect: () => {
        void deleteShownEssay(essay)
      },
    })
  }
  openRowMenu({ x, y, items, returnFocus: button })
}

async function showEssayInFolder(essay) {
  try {
    await revealEssayFile(folderHandle, essay.file)
  } catch {
    showNotice('Could not show that file.')
  }
}

async function deleteShownEssay(essay) {
  if (!folderHandle || !essay) return
  const label = [essay.code, essay.title].filter(Boolean).join(' ')
  const accepted = await askConfirm({
    title: 'Delete essay?',
    message: label
      ? `Delete "${label}"? This removes the .txt file from the folder.`
      : 'Delete this .txt file from the folder?',
  })
  if (!accepted || !folderHandle) return
  try {
    await deleteEssayFile(folderHandle, essay.file)
  } catch (error) {
    if (isFolderScopeError(error)) {
      folderNeedsGesture = true
      updateFolderChrome()
      return
    }
    setLoadError('Could not delete that essay.')
    return
  }
  setLoadError('')
  try {
    applyEssayList(await essaysFromHandle(folderHandle))
  } catch {
    setLoadError('Could not read that folder.')
  }
}

function onEssayContextMenu(event) {
  const button = elementFromEvent(event)?.closest('.essay')
  if (!button) return
  event.preventDefault()
  openEssayMenu(button, event.clientX, event.clientY)
}

function openImportMenu(button, x, y) {
  const id = button.dataset.importId
  if (!id || !imports.some((item) => item.id === id)) return
  openRowMenu({
    x,
    y,
    items: [
      { label: 'Edit', onSelect: () => openEditDialog(id) },
      { label: 'Delete', danger: true, onSelect: () => deleteImport(id) },
    ],
    returnFocus: button,
  })
}

function onImportContextMenu(event) {
  const button = elementFromEvent(event)?.closest('[data-import-id]')
  if (!button) return
  event.preventDefault()
  openImportMenu(button, event.clientX, event.clientY)
}

function onImportMenuKey(event) {
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
  const button = elementFromEvent(event)?.closest('[data-import-id]')
  if (!button) return
  event.preventDefault()
  const rect = button.getBoundingClientRect()
  openImportMenu(button, rect.left, rect.bottom)
}

function onEssayMenuKey(event) {
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
  const button = elementFromEvent(event)?.closest('.essay')
  if (!button) return
  event.preventDefault()
  const rect = button.getBoundingClientRect()
  openEssayMenu(button, rect.left, rect.bottom)
}

async function useBundledEssays() {
  let forgetError = false
  try {
    await clearSavedFolder()
  } catch {
    forgetError = true
  }
  folderHandle = null
  folderName = ''
  folderNeedsGesture = false
  applyEssayList(bundledEssays)
  setLoadError(forgetError ? 'Could not forget this folder. It may come back on the next visit.' : '')
}

function selectReading({ kind, index = 0, id = null }) {
  void stopRecordingAndSave({ openAfter: false })
  const prevKey = openTextKey({ kind: state.kind, index: state.index, importId: state.importId, essays })
  const nextKey = openTextKey({ kind, index, importId: id, essays })
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
  return filterImports(imports, state.query)
}

function renderEssayList() {
  const list = filtered()
  const ul = document.querySelector('#essay-list')
  if (!ul) return
  const empty = state.query.trim()
    ? 'No essay matches.'
    : folderNeedsGesture
      ? 'Allow this folder to show its essays.'
      : folderHandle
        ? 'No .txt files in this folder.'
        : 'No essay matches.'
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
    : `<li class="empty">${escapeHtml(empty)}</li>`
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
        <li>
          <button class="essay ${on ? 'is-on' : ''}" type="button" data-import-id="${escapeAttr(item.id)}">
            <span class="code">${escapeHtml(reading.code)}</span>
            <span class="name">${escapeHtml(item.title)}</span>
          </button>
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
  if (recorderMode() === 'recording') paintRecording()
  else if (recorderMode() === 'playback') paintPlayback()
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
  document.querySelector('#voice-enhance')?.addEventListener('change', onVoiceEnhanceChange)
  document.querySelector('#voice-enhance-panel')?.addEventListener('change', onVoiceEnhanceChange)
  renderMicSelects()
  document.querySelector('#recorder-stop')?.addEventListener('click', () => {
    void finishRecording()
  })
  document.querySelector('#recorder-pause')?.addEventListener('click', () => {
    if (recorderPaused()) resumeRecordingFromPanel()
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
    const message = folderNeedsGesture
      ? 'Allow this folder to show its essays.'
      : folderHandle
        ? 'No .txt files in this folder.'
        : 'No essays found. Add an E01-....txt file next to this reader.'
    sheet.innerHTML = `<p class="empty">${message}</p>`
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
          <input id="rec-with-run" type="checkbox" ${isRecWithRun() ? 'checked' : ''} />
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
        ${voiceEnhanceControl('voice-enhance')}
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
            <div class="side-tools">
              <button class="tool reload" id="reload" type="button" aria-label="Reload essays" ${import.meta.env.DEV || folderHandle ? '' : 'hidden'}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 12a9 9 0 1 1-2.6-6.3" />
                  <path d="M21 4v5h-5" />
                </svg>
              </button>
              <button class="tool folder-pick" id="choose-folder" type="button">
                ${FOLDER_ICON}
                Folder
              </button>
            </div>
          </div>
          <p id="folder-name" class="folder-name" ${folderName ? '' : 'hidden'}></p>
          <p id="load-error" class="load-error" role="status" hidden></p>
          <button class="folder-reset" id="use-app-essays" type="button" ${folderHandle ? '' : 'hidden'}>Use app essays</button>
          <ul id="essay-list"></ul>
          <div class="side-head imports-head">
            <p class="side-label" id="imports-label">My texts</p>
            <button class="tool folder-pick" id="import-open" type="button">Import</button>
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
    void reloadEssays()
  })
  document.querySelector('#choose-folder')?.addEventListener('click', () => {
    void chooseFolder()
  })
  document.querySelector('#use-app-essays')?.addEventListener('click', () => {
    void useBundledEssays()
  })
  updateFolderChrome()
  document.querySelector('#theme').addEventListener('click', () => {
    setTheme(theme() === 'dark' ? 'light' : 'dark')
  })
  document.querySelector('#menu').addEventListener('click', () => {
    setDrawer(!state.drawer)
  })
  document.querySelector('#backdrop').addEventListener('click', () => {
    setDrawer(false)
  })
  const essayList = document.querySelector('#essay-list')
  essayList.addEventListener('click', (event) => {
    const button = event.target.closest('.essay')
    if (!button) return
    select(Number(button.dataset.index))
  })
  essayList.addEventListener('contextmenu', onEssayContextMenu)
  essayList.addEventListener('keydown', onEssayMenuKey)
  document.querySelector('#import-open').addEventListener('click', openImportDialog)
  const importList = document.querySelector('#import-list')
  importList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-import-id]')
    if (button) selectImport(button.dataset.importId)
  })
  importList.addEventListener('contextmenu', onImportContextMenu)
  importList.addEventListener('keydown', onImportMenuKey)
  const takesList = document.querySelector('#takes-list')
  takesList?.addEventListener('click', onTakesClick)
  takesList?.addEventListener('contextmenu', onTakesContextMenu)
  takesList?.addEventListener('keydown', onTakesMenuKey)
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

bridge.isRunning = () => state.running
bridge.pauseRun = pauseRun
bridge.playRun = playRun
bridge.current = current
bridge.escapeHtml = escapeHtml
bridge.escapeAttr = escapeAttr
bridge.askConfirm = askConfirm
bridge.showNotice = showNotice

readStorage(THEME_KEY)
async function start() {
  if (inTauri()) {
    let closing = false
    await getCurrentWindow().onCloseRequested(async (event) => {
      if (closing) {
        event.preventDefault()
        return
      }
      closing = true
      saveProgressNow()
      await stopRecordingAndSave({ openAfter: false })
    }).catch((error) => console.error('Could not listen for window close requests.', error))
  }
  try {
    await adoptSavedFolder()
  } catch {
    if (folderHandle) folderNeedsGesture = true
  }
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
}

void start()

function onPageLeave() {
  saveProgressNow()
  if (recordingActive()) void stopRecordingAndSave()
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

document.addEventListener('contextmenu', (event) => {
  event.preventDefault()
})

function isTypingTarget(target) {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable ||
    (target instanceof HTMLInputElement && ['search', 'text', 'checkbox'].includes(target.type))
  )
}

document.addEventListener('keydown', (event) => {
  if (document.querySelector('dialog[open]')) return
  if (event.target instanceof Element && event.target.closest('.row-menu')) return
  const typing = isTypingTarget(event.target)
  if (event.key === 'Escape') {
    const frame = frameEl()
    if (frame?.classList.contains('is-fullscreen') && document.fullscreenElement !== frame) setFullscreenMode(false)
    return
  }
  if (event.key === ' ') {
    if (typing) return
    if (event.target instanceof Element && event.target.closest('.take-select')) return
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
