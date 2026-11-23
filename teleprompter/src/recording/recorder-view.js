/**
 * Recorder panel markup and the live control chrome.
 */
import { recMessageAfter } from './rec-messages.js'
import { panelChromeState, recControlState } from './recorder-math.js'

const STOP_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5" fill="currentColor"/></svg>`
const PAUSE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>`
const PLAY_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.2v13.6l11-6.8z"/></svg>`
const CLOSE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`

export function recMessageMarkup(className = 'rec-message') {
  return `<p class="${className}" data-rec-message role="alert" hidden><span class="rec-message-text" data-rec-message-text></span><button class="btn rec-message-dismiss" type="button" data-rec-dismiss aria-label="Dismiss">✕</button></p>`
}

export function createRecorderView({ getVoiceEnhance, getPanelMode, getCapturePhase, getPlayback, syncMicControls }) {
  let current = ''

  function paintRecMessage() {
    const text = current || ''
    for (const el of document.querySelectorAll('[data-rec-message]')) {
      const slot = el.querySelector?.('[data-rec-message-text]')
      if (slot) slot.textContent = text
      el.hidden = !text
    }
  }

  function showRecMessage(message) {
    current = message || ''
    paintRecMessage()
  }

  function applyRecMessageEvent(event) {
    const next = recMessageAfter(current, event)
    if (next === current) return
    showRecMessage(next)
  }

  function onRecMessageClick(event) {
    const target = event?.target
    const button =
      typeof target?.closest === 'function'
        ? target.closest('[data-rec-dismiss]')
        : typeof target?.parentElement?.closest === 'function'
          ? target.parentElement.closest('[data-rec-dismiss]')
          : null
    if (!button) return
    applyRecMessageEvent('dismiss')
  }

  document.addEventListener?.('click', onRecMessageClick)

  function syncPanelChrome() {
    const panel = document.querySelector('#recorder-panel')
    if (!panel) return
    const playback = getPlayback()
    const playbackPaused = !playback?.audio || playback.audio.paused || playback.audio.ended
    const view = panelChromeState({ mode: getPanelMode(), phase: getCapturePhase(), playbackPaused })
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

  function syncRecUi() {
    const view = recControlState(getCapturePhase())
    for (const button of document.querySelectorAll('#rec, #rec-stage')) {
      button.setAttribute('aria-pressed', view.pressed)
      button.classList.toggle('is-recording', view.recording)
      button.classList.toggle('is-paused', view.paused)
      button.setAttribute('aria-label', view.label)
    }
    if (getPanelMode() === 'recording') syncPanelChrome()
  }

  function voiceEnhanceControl(id) {
    return `<label class="voice-enhance"><input class="voice-enhance-input" id="${id}" type="checkbox" ${getVoiceEnhance() ? 'checked' : ''} />Voice enhance</label>`
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

  return {
    showRecMessage,
    noteRecordingStarted() {
      applyRecMessageEvent('recording-started')
    },
    noteTakeSaved() {
      applyRecMessageEvent('take-saved')
    },
    noteDeviceReturned() {
      applyRecMessageEvent('device-returned')
    },
    syncRecUi,
    syncPanelChrome,
    voiceEnhanceControl,
    recorderPanelHtml,
  }
}
