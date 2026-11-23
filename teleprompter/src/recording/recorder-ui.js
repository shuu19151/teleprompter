/**
 * Recorder composition root. main.js creates this once and passes the
 * reader, library, and shell callbacks it needs.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { warmRecordingStore } from './recording.js'
import { createMicrophoneController } from './microphone-controller.js'
import { createRecorderController } from './recorder-controller.js'
import { createRecorderView } from './recorder-view.js'
import { createTakeList } from './take-list.js'
import { createWaveformView } from './waveform-view.js'

export function createRecorder(deps) {
  let recorder
  let ui

  const microphone = createMicrophoneController({
    getCapture: () => recorder.capture,
    getPanelMode: () => recorder.getMode(),
    nativeDevices:
      deps.recorderKind === 'native'
        ? {
            list: () => invoke('recorder_list_devices'),
            listen: (name, handler) => listen(name, handler),
          }
        : null,
    onDeviceLost: (payload) => recorder.onDeviceLost(payload),
    onInputDeviceFound: () => ui?.noteDeviceReturned(),
    showRecMessage: (message) => ui?.showRecMessage(message),
    onMicReady: () => ui?.noteMicReady(),
    stopIfActive: () => (recorder.recordingActive() ? recorder.stopRecordingAndSave() : null),
  })

  ui = createRecorderView({
    getPanelMode: () => recorder.getMode(),
    getCapturePhase: () => recorder.capture.phase,
    getPlayback: () => recorder.getPlayback(),
    syncMicControls: () => microphone.syncMicControls(),
  })

  const wave = createWaveformView({
    getAnalyser: () => microphone.getAnalyser(),
    resumeAudio: () => microphone.resumeIfSuspended(),
    getElapsedMs: () => recorder.capture.elapsedMs(),
    getCapturePhase: () => recorder.capture.phase,
    getPanelMode: () => recorder.getMode(),
    getPlayback: () => recorder.getPlayback(),
  })

  const takes = createTakeList({
    getPanelMode: () => recorder.getMode(),
    getPlayback: () => recorder.getPlayback(),
    isRecordingActive: () => recorder.recordingActive(),
    closeRecorderPanel: () => recorder.closeRecorderPanel(),
    stopRecordingAndSave: (options) => recorder.stopRecordingAndSave(options),
    openPlayback: (take) => recorder.openPlayback(take),
    togglePlayback: () => recorder.togglePlayback(),
    deps,
  })

  recorder = createRecorderController({
    microphone,
    ui,
    wave,
    takes,
    deps,
    recorderKind: deps.recorderKind,
  })

  function refreshAudioInputs() {
    return microphone.refreshAudioInputs()
  }

  return {
    syncRecorderToRun() {
      recorder.syncRecorderToRun()
    },
    showRecMessage(message) {
      ui.showRecMessage(message)
    },
    syncRecUi() {
      ui.syncRecUi()
    },
    onThemeChange() {
      wave.onThemeChange()
    },
    renderMicSelects() {
      microphone.renderMicSelects()
    },
    refreshAudioInputs,
    onMicChange(event) {
      microphone.onMicChange(event)
    },
    noteReaderOpen(open) {
      return microphone.noteReaderOpen(open)
    },
    notePageVisibility(visible) {
      return microphone.notePageVisibility(visible)
    },
    resetRulerTrack() {
      wave.resetRulerTrack()
    },
    paintRecording() {
      wave.paintRecording()
    },
    bindWavePointer() {
      wave.bindWavePointer()
    },
    paintPlayback(forcedTime) {
      wave.paintPlayback(forcedTime)
    },
    closeRecorderPanel() {
      recorder.closeRecorderPanel()
    },
    restoreRecorderPanel() {
      recorder.restoreRecorderPanel()
    },
    togglePlayback() {
      recorder.togglePlayback()
    },
    renderTakes() {
      return takes.renderTakes()
    },
    stopRecordingAndSave(options) {
      return recorder.stopRecordingAndSave(options)
    },
    startRecording() {
      return recorder.startRecording()
    },
    finishRecording(options) {
      return recorder.finishRecording(options)
    },
    toggleRecording() {
      return recorder.toggleRecording()
    },
    pauseRecordingFromPanel() {
      recorder.pauseRecordingFromPanel()
    },
    resumeRecordingFromPanel() {
      recorder.resumeRecordingFromPanel()
    },
    onRecWithRunChange(event) {
      recorder.onRecWithRunChange(event)
    },
    onTakesContextMenu(event) {
      takes.onTakesContextMenu(event)
    },
    onTakesMenuKey(event) {
      takes.onTakesMenuKey(event)
    },
    onTakesClick(event) {
      takes.onTakesClick(event)
    },
    isRecWithRun() {
      return recorder.isRecWithRun()
    },
    recordingActive() {
      return recorder.recordingActive()
    },
    recorderPaused() {
      return recorder.recorderPaused()
    },
    recorderMode() {
      return recorder.getMode()
    },
    recorderPanelHtml() {
      return ui.recorderPanelHtml()
    },
    warmStore() {
      void warmRecordingStore()
    },
    watchAudioInputs() {
      if (deps.recorderKind === 'native') {
        void microphone.watchNativeDevices()
        return
      }
      void refreshAudioInputs()
      navigator.mediaDevices?.addEventListener?.('devicechange', () => {
        void refreshAudioInputs()
      })
    },
  }
}
