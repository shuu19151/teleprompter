import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/literata/latin-400.css'
import '@fontsource/literata/latin-700.css'
import './style.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { essayStorageRecord, itemKey, positionApplies } from './library/content-selection.js'
import { isEssayFile } from './library/essay-files.js'
import { inTauri } from './library/essay-folder.js'
import { createLibrary } from './library/library-controller.js'
import { createImportDialog } from './library/import-dialog.js'
import { parseEssay } from './library/import-store.js'
import { createSidebar, stageEmptyMessage } from './library/sidebar-view.js'
import { advanceReading, parseSpeed, wheelDistance as wheelPixels } from './reading/reader-controller.js'
import { FONT_MAX, FONT_MIN, clampFontSize, parseFontSize } from './reading/reader-layout.js'
import { capturedPlace, savedReadingPosition } from './reading/reader-progress.js'
import { renderScriptHtml } from './reading/reader-view.js'
import {
  READING_RATIO,
  anchorOffset,
  clampOffset,
  findActiveIndex as activeLineIndex,
  formatRemaining as formatSecondsLeft,
  fractionAtOffset as fractionOnLine,
  offsetForFraction as offsetOnLine,
  pixelsPerSecond as scrollPixelsPerSecond,
  progressRatio,
  readingFromTop as guideFromTop,
  remainingSeconds,
  restoreOffset,
  scriptFocusY as focusYFor,
} from './reading/reader-math.js'
import { warmRecordingStore } from './recording/recording.js'
import { createConfirmDialog } from './shell/confirm-dialog.js'
import { ENTER_ICON, createFullscreen } from './shell/fullscreen.js'
import { showNotice } from './shell/notifications.js'
import { bindThemeToggle, readThemeStorage, theme } from './shell/theme.js'
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
  stopRecordingAndSave,
  syncRecUi,
  syncRecorderToRun,
  togglePlayback,
  toggleRecording,
  voiceEnhanceControl,
} from './recording/recorder-ui.js'

const SPEED_KEY = 'teleprompter:speed'
const ESSAY_KEY = 'teleprompter:essay'
const POSITION_KEY = 'teleprompter:position'
const FONT_KEY = 'teleprompter:fontSize'
const SAVE_DELAY = 300
const MIC_ICON = `<svg class="mic-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M8.5 21h7"/></svg>`
const LEGACY_KEYS = {
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
  return parseSpeed(readStorage(SPEED_KEY))
}

function loadFontSize() {
  return parseFontSize(loadJSON(FONT_KEY))
}

function essaysFromGlob() {
  return Object.entries(files)
    .filter(([path]) => isEssayFile(path))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, raw]) => parseEssay(path, raw))
}

const bundledEssays = essaysFromGlob()

const state = {
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
  return scrollPixelsPerSecond(state.speed)
}

function readingFromTop() {
  return guideFromTop(offsetCache.height)
}

/** Script-space Y of the guide, one third down the stage. */
function scriptFocusY() {
  return focusYFor({ offset: state.offset, height: offsetCache.height, focusShift: offsetCache.focusShift })
}

function offsetForFraction(top, height, fraction) {
  return offsetOnLine(top, height, fraction, { readingFromTop: readingFromTop(), focusShift: offsetCache.focusShift })
}

function fractionAtOffset(top, height) {
  return fractionOnLine(top, height, scriptFocusY())
}

function maxOffset() {
  return offsetCache.max
}

function renderLines(body) {
  return renderScriptHtml(body, escapeHtml)
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
  return activeLineIndex(lineMetrics, focusY)
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
  const next = anchorOffset({
    anchor,
    metrics: lineMetrics,
    width: offsetCache.width,
    height: offsetCache.height,
    max: offsetCache.max,
    readingFromTop: readingFromTop(),
    focusShift: offsetCache.focusShift,
  })
  if (next === null) return
  state.offset = next
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
  return formatSecondsLeft(seconds)
}

function updateProgress() {
  const bar = document.querySelector('#progress-bar')
  const label = document.querySelector('#progress-time')
  if (!bar && !label) return
  const max = offsetCache.max
  const ratio = progressRatio(state.offset, max)
  if (bar) {
    bar.style.transform = `scaleX(${ratio})`
    bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  }
  if (label) {
    const seconds = remainingSeconds(state.offset, max, pixelsPerSecond())
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
  const hasLine = Boolean(metric && offsetCache.height)
  const fraction = hasLine ? fractionAtOffset(metric.top, metric.height) : 0
  writeStorage(
    POSITION_KEY,
    JSON.stringify(
      savedReadingPosition({ hasLine, index: activeIndex, fraction, offset: state.offset, id: record.id }),
    ),
  )
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
  const step = advanceReading({
    offset: state.offset,
    running: state.running,
    wheelLeft,
    dt,
    rate: pixelsPerSecond(),
    limit: maxOffset(),
  })
  state.offset = step.offset
  wheelLeft = step.wheelLeft
  state.running = step.running
  if (step.reachedEnd) {
    syncRunButton()
    saveProgressNow()
    // The last line stops the scroll only. Recording keeps going until Stop.
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
  return wheelPixels(event.deltaMode, event.deltaY, view?.clientHeight || 0)
}

function scrollBy(distance) {
  if (!distance) return
  const limit = maxOffset()
  const destination = clampOffset(state.offset + wheelLeft + distance, limit)
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

function restorePosition() {
  const saved = loadJSON(POSITION_KEY)
  if (!positionApplies(saved, itemKey(current()))) return
  const next = restoreOffset({
    saved,
    lineMetrics,
    max: offsetCache.max,
    readingFromTop: readingFromTop(),
    focusShift: offsetCache.focusShift,
  })
  if (!next) return
  if (next.restoredAnchor) restoredAnchor = next.restoredAnchor
  if (next.anchor) anchor = next.anchor
  state.offset = next.offset
}

function capturedReadingPlace() {
  return capturedPlace(activeIndex, anchor)
}

function placeReading(index, fraction) {
  anchor = { index, fraction, width: -1, height: -1 }
}

function applyFontSize(next) {
  const size = clampFontSize(next)
  if (size === null) return
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
    fullscreen.toggleFullscreen()
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
    const message = stageEmptyMessage({
      folderNeedsGesture: library.folderNeedsGesture,
      folderHandle: library.folderHandle,
    })
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
  const app = document.querySelector('#app')
  app.innerHTML = `
    <div class="window">
      <header class="topbar">
        <button class="menu" id="menu" type="button" aria-label="Essays" aria-controls="sidebar" aria-expanded="false">Menu</button>
        <div class="brand">Teleprompter</div>
        <label class="search">
          <span class="sr">Search essays and texts</span>
          <input id="search" type="search" placeholder="Search" value="${escapeAttr(library.query)}" />
        </label>
        <button class="tool" id="theme" type="button">${theme() === 'dark' ? 'Light' : 'Dark'}</button>
      </header>
      <div class="body">
${sidebar.markup()}
        <button class="backdrop" id="backdrop" type="button" aria-label="Close menu"></button>
        <main class="sheet"></main>
      </div>
    </div>
${importDialog.markup()}
${confirmDialog.markup()}
  `
  sidebar.bind()
  bindThemeToggle()
  const takesList = document.querySelector('#takes-list')
  takesList?.addEventListener('click', onTakesClick)
  takesList?.addEventListener('contextmenu', onTakesContextMenu)
  takesList?.addEventListener('keydown', onTakesMenuKey)
  confirmDialog.bind()
  importDialog.bind()
  sidebar.renderList()
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

function current() {
  return library.current()
}

const fullscreen = createFullscreen({
  onLayout() {
    if (anchor) anchor = { index: anchor.index, fraction: anchor.fraction, width: -1, height: -1 }
    measure()
    applyOffset()
    if (recorderMode() === 'recording') paintRecording()
    else if (recorderMode() === 'playback') paintPlayback()
  },
})

const confirmDialog = createConfirmDialog()

const library = createLibrary({
  bundledEssays,
  loadJSON,
  deps: {
    stopRecordingAndSave,
    closeRecorderPanel,
    saveProgressNow,
    renderSheet,
    restorePosition,
    applyOffset,
    stopLoop,
    syncRunButton,
    setRunning(value) {
      state.running = value
    },
    setWheelLeft(value) {
      wheelLeft = value
    },
    setOffset(value) {
      state.offset = value
    },
    getOffset() {
      return state.offset
    },
    setAnchor(value) {
      anchor = value
    },
    maxOffset,
    capturedReadingPlace,
    placeReading,
    setDrawer(open) {
      sidebar.setDrawer(open)
    },
    renderList() {
      sidebar.renderList()
    },
    renderImportList() {
      sidebar.renderImportList()
    },
    updateFolderChrome() {
      sidebar.updateFolderChrome()
    },
    setLoadError(message) {
      sidebar.setLoadError(message)
    },
    showImportNote(message) {
      sidebar.showImportNote(message)
    },
    clearImportNote() {
      sidebar.clearImportNote()
    },
    askConfirm(options) {
      return confirmDialog.askConfirm(options)
    },
    showNotice,
  },
})

const importDialog = createImportDialog({
  getImports: () => library.imports,
  addImport: (raw, options) => library.addImport(raw, options),
  updateImport: (id, title, body, meta) => library.updateImport(id, title, body, meta),
  selectImport: (id) => library.selectImport(id),
})

const sidebar = createSidebar({
  library,
  escapeHtml,
  escapeAttr,
  inTauri,
  openImportDialog: () => importDialog.openImportDialog(),
  openEditDialog: (id) => importDialog.openEditDialog(id),
})

bridge.isRunning = () => state.running
bridge.pauseRun = pauseRun
bridge.playRun = playRun
bridge.current = current
bridge.escapeHtml = escapeHtml
bridge.escapeAttr = escapeAttr
bridge.askConfirm = confirmDialog.askConfirm
bridge.showNotice = showNotice

readThemeStorage()

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
  await library.bootFolder()
  library.restoreEssay()
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

fullscreen.bindChange()

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
    fullscreen.onEscape()
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
    fullscreen.toggleFullscreen()
    return
  }
  if ((event.key === 'r' || event.key === 'R') && plain) {
    event.preventDefault()
    void toggleRecording()
  }
})
