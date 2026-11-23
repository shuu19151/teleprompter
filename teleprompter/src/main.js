import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/literata/latin-400.css'
import '@fontsource/literata/latin-700.css'
import './style.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isEssayFile } from './library/essay-files.js'
import { inTauri } from './library/essay-folder.js'
import { createImportDialog } from './library/import-dialog.js'
import { parseEssay } from './library/import-store.js'
import { createLibrary } from './library/library-controller.js'
import { createSidebar, stageEmptyMessage } from './library/sidebar-view.js'
import { SPEED_KEY, createReaderController } from './reading/reader-controller.js'
import { createReaderLayout } from './reading/reader-layout.js'
import { createReaderProgress } from './reading/reader-progress.js'
import { createReaderView } from './reading/reader-view.js'
import { warmRecordingStore } from './recording/recording.js'
import { createRecorder } from './recording/recorder-ui.js'
import { createConfirmDialog } from './shell/confirm-dialog.js'
import { createFullscreen } from './shell/fullscreen.js'
import { showNotice } from './shell/notifications.js'
import { bindThemeToggle, readThemeStorage, theme } from './shell/theme.js'

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

function essaysFromGlob() {
  return Object.entries(files)
    .filter(([path]) => isEssayFile(path))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, raw]) => parseEssay(path, raw))
}

const bundledEssays = essaysFromGlob()

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

const confirmDialog = createConfirmDialog()

const recorder = createRecorder({
  isRunning: () => reader.isRunning(),
  pauseRun: () => reader.pauseRun(),
  playRun: () => reader.playRun(),
  current: () => library.current(),
  escapeHtml,
  escapeAttr,
  askConfirm: (options) => confirmDialog.askConfirm(options),
  showNotice,
})

const layout = createReaderLayout({
  loadJSON,
  writeStorage,
  getOffset: () => reader.getOffset(),
  setOffset: (value) => reader.setOffset(value),
  getActiveIndex: () => view.getActiveIndex(),
  applyOffset: () => reader.applyOffset(),
  scheduleSave: () => progress.scheduleSave(),
})

const progress = createReaderProgress({
  writeStorage,
  loadJSON,
  current: () => library.current(),
  getActiveIndex: () => view.getActiveIndex(),
  getLineMetrics: () => layout.getLineMetrics(),
  getOffsetCache: () => layout.getOffsetCache(),
  fractionAtOffset: (top, height) => layout.fractionAtOffset(top, height),
  getOffset: () => reader.getOffset(),
  setOffset: (value) => reader.setOffset(value),
  getAnchor: () => layout.getAnchor(),
  setAnchor: (value) => layout.setAnchor(value),
  readingFromTop: () => layout.readingFromTop(),
})

const view = createReaderView({
  escapeHtml,
  current: () => library.current(),
  folderState: () => ({
    folderNeedsGesture: library.folderNeedsGesture,
    folderHandle: library.folderHandle,
  }),
  stageEmptyMessage,
  isRunning: () => reader.isRunning(),
  getSpeed: () => reader.getSpeed(),
  getFontSize: () => layout.getFontSize(),
  getOffset: () => reader.getOffset(),
  getLineNodes: () => layout.getLineNodes(),
  getLineMetrics: () => layout.getLineMetrics(),
  getOffsetCache: () => layout.getOffsetCache(),
  scriptFocusY: () => layout.scriptFocusY(),
  pixelsPerSecond: () => reader.pixelsPerSecond(),
  clearMetrics: () => layout.clearMetrics(),
  measure: () => layout.measure(),
  observeView: (element) => layout.observeView(element),
  disconnectView: () => layout.disconnectView(),
  restoreIfNeeded: () => progress.restoreIfNeeded(),
  applyOffset: () => reader.applyOffset(),
  startLoop: () => reader.startLoop(),
  toggleRun: () => reader.toggleRun(),
  setSpeed: (value) => reader.setSpeed(value),
  applyFontSize: (value) => layout.applyFontSize(value),
  scrollBy: (distance) => reader.scrollBy(distance),
  toTop: () => reader.toTop(),
  toggleFullscreen: () => fullscreen.toggleFullscreen(),
  recording: recorder,
})

const reader = createReaderController({
  readStorage,
  writeStorage,
  getCurrent: () => library.current(),
  layout,
  progress,
  view,
  syncRecorderToRun: recorder.syncRecorderToRun,
  toggleRecording: recorder.toggleRecording,
  onEscape: () => fullscreen.onEscape(),
  toggleFullscreen: () => fullscreen.toggleFullscreen(),
})

const fullscreen = createFullscreen({
  onLayout() {
    layout.invalidateAnchor()
    layout.measure()
    reader.applyOffset()
    if (recorder.recorderMode() === 'recording') recorder.paintRecording()
    else if (recorder.recorderMode() === 'playback') recorder.paintPlayback()
  },
})

const library = createLibrary({
  bundledEssays,
  loadJSON,
  deps: {
    stopRecordingAndSave: recorder.stopRecordingAndSave,
    closeRecorderPanel: recorder.closeRecorderPanel,
    saveProgressNow: progress.saveProgressNow,
    renderSheet: view.renderSheet,
    restorePosition: progress.restorePosition,
    applyOffset: reader.applyOffset,
    stopLoop: reader.stopLoop,
    syncRunButton: view.syncRunButton,
    setRunning: reader.setRunning,
    setWheelLeft: reader.setWheelLeft,
    setOffset: reader.setOffset,
    getOffset: reader.getOffset,
    setAnchor: layout.setAnchor,
    maxOffset: layout.maxOffset,
    capturedReadingPlace: progress.capturedReadingPlace,
    placeReading: progress.placeReading,
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

readThemeStorage()

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
  bindThemeToggle({ onThemeChange: recorder.onThemeChange })
  const takesList = document.querySelector('#takes-list')
  takesList?.addEventListener('click', recorder.onTakesClick)
  takesList?.addEventListener('contextmenu', recorder.onTakesContextMenu)
  takesList?.addEventListener('keydown', recorder.onTakesMenuKey)
  confirmDialog.bind()
  importDialog.bind()
  sidebar.renderList()
  view.renderSheet()
}

async function start() {
  if (inTauri()) {
    let closing = false
    await getCurrentWindow().onCloseRequested(async (event) => {
      if (closing) {
        event.preventDefault()
        return
      }
      closing = true
      progress.saveProgressNow()
      await recorder.stopRecordingAndSave({ openAfter: false })
    }).catch((error) => console.error('Could not listen for window close requests.', error))
  }
  await library.bootFolder()
  library.restoreEssay()
  void warmRecordingStore()
  layout.syncScriptSize()
  mount()
  void recorder.refreshAudioInputs()
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    void recorder.refreshAudioInputs()
  })
  reader.remeasureWhenFontsReady()
}

void start()

function onPageLeave() {
  progress.saveProgressNow()
  if (recorder.recordingActive()) void recorder.stopRecordingAndSave()
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

reader.bindKeyboard()
