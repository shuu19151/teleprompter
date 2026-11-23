/**
 * Recorder composition root. main.js keeps importing this module.
 */
import { createMicrophoneController } from './microphone-controller.js'
import { createRecorderController } from './recorder-controller.js'
import { createRecorderView } from './recorder-view.js'
import { createTakeList } from './take-list.js'
import { createWaveformView } from './waveform-view.js'

let recorder

const microphone = createMicrophoneController({
  getCapture: () => recorder.capture,
  getPanelMode: () => recorder.getMode(),
})

const ui = createRecorderView({
  getVoiceEnhance: () => microphone.isVoiceEnhance(),
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
  showRecMessage: (message) => ui.showRecMessage(message),
})

recorder = createRecorderController({ microphone, ui, wave, takes })

export function syncRecorderToRun() {
  recorder.syncRecorderToRun()
}

export function showRecMessage(message) {
  ui.showRecMessage(message)
}

export function syncRecUi() {
  ui.syncRecUi()
}

export function onThemeChange() {
  wave.onThemeChange()
}

export function renderMicSelects() {
  microphone.renderMicSelects()
}

export async function refreshAudioInputs() {
  return microphone.refreshAudioInputs()
}

export function onMicChange(event) {
  microphone.onMicChange(event)
}

export function onVoiceEnhanceChange(event) {
  microphone.onVoiceEnhanceChange(event)
}

export function resetRulerTrack() {
  wave.resetRulerTrack()
}

export function paintRecording() {
  wave.paintRecording()
}

export function bindWavePointer() {
  wave.bindWavePointer()
}

export function paintPlayback(forcedTime) {
  wave.paintPlayback(forcedTime)
}

export function closeRecorderPanel() {
  recorder.closeRecorderPanel()
}

export function restoreRecorderPanel() {
  recorder.restoreRecorderPanel()
}

export function togglePlayback() {
  recorder.togglePlayback()
}

export async function renderTakes() {
  return takes.renderTakes()
}

export function stopRecordingAndSave(options) {
  return recorder.stopRecordingAndSave(options)
}

export function startRecording() {
  return recorder.startRecording()
}

export function finishRecording(options) {
  return recorder.finishRecording(options)
}

export function toggleRecording() {
  return recorder.toggleRecording()
}

export function pauseRecordingFromPanel() {
  recorder.pauseRecordingFromPanel()
}

export function resumeRecordingFromPanel() {
  recorder.resumeRecordingFromPanel()
}

export function onRecWithRunChange(event) {
  recorder.onRecWithRunChange(event)
}

export function onTakesContextMenu(event) {
  takes.onTakesContextMenu(event)
}

export function onTakesMenuKey(event) {
  takes.onTakesMenuKey(event)
}

export function onTakesClick(event) {
  takes.onTakesClick(event)
}

export function voiceEnhanceControl(id) {
  return ui.voiceEnhanceControl(id)
}

export function isRecWithRun() {
  return recorder.isRecWithRun()
}

export function recordingActive() {
  return recorder.recordingActive()
}

export function recorderPaused() {
  return recorder.recorderPaused()
}

export function recorderMode() {
  return recorder.getMode()
}

export function recorderPanelHtml() {
  return ui.recorderPanelHtml()
}
