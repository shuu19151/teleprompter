/**
 * Composition root. Imports each domain, passes the callbacks it needs, and starts the app.
 */
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/literata/latin-400.css'
import '@fontsource/literata/latin-600.css'
import './style.css'
import { loadBundledEssays } from './library/bundled-essays.js'
import { inTauri } from './library/essay-folder.js'
import { createImportDialog } from './library/import-dialog.js'
import { createLibrary } from './library/library-controller.js'
import { createTextsStore } from './library/texts-store.js'
import { createSidebar, stageEmptyMessage } from './library/sidebar-view.js'
import { createReaderController } from './reading/reader-controller.js'
import { createReaderLayout } from './reading/reader-layout.js'
import { createReaderProgress } from './reading/reader-progress.js'
import { createReaderView } from './reading/reader-view.js'
import { hasTauriGlobal, selectRecorderBackend } from './recording/recorder-backend.js'
import { recoverUnfinishedRecordings } from './recording/recorder-recovery.js'
import { createRecorder } from './recording/recorder-ui.js'
import { mountApp } from './shell/app-shell.js'
import { createConfirmDialog } from './shell/confirm-dialog.js'
import { createFullscreen } from './shell/fullscreen.js'
import { bindContextMenuBlock, bindPageLeave, bindWindowClose } from './shell/lifecycle.js'
import { showNotice } from './shell/notifications.js'
import { readThemeStorage } from './shell/theme.js'
import { escapeAttr, escapeHtml } from './shared/html.js'
import { loadJSON, readStorage, writeStorage } from './shared/storage.js'

const bundledEssays = loadBundledEssays()

const confirmDialog = createConfirmDialog()

// The desktop window always records natively. The Vite page keeps MediaRecorder
// so the Playwright smoke test can run without a microphone device from cpal.
const recorderKind = selectRecorderBackend({
  hasTauri: hasTauriGlobal(globalThis.window),
})

const recorder = createRecorder({
  recorderKind,
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

const textsStore = createTextsStore()

const library = createLibrary({
  bundledEssays,
  loadJSON,
  texts: textsStore,
  deps: {
    stopRecordingAndSave: recorder.stopRecordingAndSave,
    isEditing: () => Boolean(document.querySelector('#import-dialog')?.open),
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

async function start() {
  if (inTauri()) {
    await bindWindowClose(async () => {
      progress.saveProgressNow()
      await recorder.stopRecordingAndSave({ openAfter: false })
      recorder.notePageVisibility(false)
    })
  }
  await library.bootTexts()
  library.restoreEssay()
  await recorder.warmStore()
  layout.syncScriptSize()
  mountApp({
    sidebar,
    importDialog,
    confirmDialog,
    onThemeChange: recorder.onThemeChange,
    onTakesClick: recorder.onTakesClick,
    onTakesContextMenu: recorder.onTakesContextMenu,
    onTakesMenuKey: recorder.onTakesMenuKey,
    onTakesPointerDown: recorder.onTakesPointerDown,
    onTakesPointerMove: recorder.onTakesPointerMove,
    onTakesPointerEnd: recorder.onTakesPointerEnd,
    renderSheet: view.renderSheet,
  })
  if (inTauri()) {
    try {
      const { invoke, addPluginListener } = await import('@tauri-apps/api/core')
      if (/Android/i.test(navigator.userAgent)) {
        const applyIncoming = (payload) => {
          if (!payload || (!payload.body && !payload.title)) return
          importDialog.openImportDialogWithDraft({
            title: payload.title || '',
            body: payload.body || '',
            fileName: payload.fileName || '',
            markdown: Boolean(payload.markdown),
          })
        }
        await addPluginListener('android-documents', 'pendingImport', applyIncoming)
        const res = await invoke('plugin:android-documents|consumePendingImport')
        if (res?.pending) applyIncoming(res.pending)
      }
      await recoverUnfinishedRecordings({
        invoke: (command, args) => invoke(command, args),
        askConfirm: (options) => confirmDialog.askConfirm(options),
      })
    } catch (error) {
      console.error('Could not recover an unfinished recording.', error)
    }
  }
  recorder.watchAudioInputs()
  reader.remeasureWhenFontsReady()
}

void start()

bindPageLeave(() => {
  progress.saveProgressNow()
  recorder.notePageVisibility(false)
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') recorder.notePageVisibility(true)
})

fullscreen.bindChange()
bindContextMenuBlock()
reader.bindKeyboard()
