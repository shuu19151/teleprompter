import { recMessageMarkup } from '../recording/recorder-view.js'
import { ENTER_ICON } from '../shell/fullscreen.js'
import { wheelDistance } from './reader-controller.js'
import { FONT_MAX, FONT_MIN } from './reader-layout.js'
import {
  findActiveIndex as activeLineIndex,
  formatRemaining,
  progressRatio,
  remainingSeconds,
} from './reader-math.js'

const MIC_ICON = `<svg class="mic-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M8.5 21h7"/></svg>`

export function renderScriptHtml(body, escapeHtml) {
  return body
    .split('\n')
    .map((line) => (line.trim() ? `<p class="line">${escapeHtml(line)}</p>` : '<div class="gap"></div>'))
    .join('')
}

export function createReaderView({
  escapeHtml,
  current,
  folderState,
  stageEmptyMessage,
  isRunning,
  getSpeed,
  getFontSize,
  getOffset,
  getLineNodes,
  getLineMetrics,
  getOffsetCache,
  scriptFocusY,
  pixelsPerSecond,
  clearMetrics,
  measure,
  observeView,
  disconnectView,
  restoreIfNeeded,
  applyOffset,
  startLoop,
  toggleRun,
  setSpeed,
  applyFontSize,
  scrollBy,
  toTop,
  toggleFullscreen,
  recording,
}) {
  let activeIndex = -1
  let recorderResizeObserver = null

  function renderLines(body) {
    return renderScriptHtml(body, escapeHtml)
  }

  function paintFocus(next) {
    const lineNodes = getLineNodes()
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
    const lineMetrics = getLineMetrics()
    if (!lineMetrics.length) return
    const next = activeLineIndex(lineMetrics, scriptFocusY())
    if (next === activeIndex) return
    paintFocus(next)
  }

  function updateProgress() {
    const bar = document.querySelector('#progress-bar')
    const label = document.querySelector('#progress-time')
    if (!bar && !label) return
    const max = getOffsetCache().max
    const ratio = progressRatio(getOffset(), max)
    if (bar) {
      bar.style.transform = `scaleX(${ratio})`
      bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
    }
    if (label) {
      const seconds = remainingSeconds(getOffset(), max, pixelsPerSecond())
      label.textContent = formatRemaining(seconds)
    }
  }

  function syncRunButton() {
    const button = document.querySelector('#run')
    if (!button) return
    const running = isRunning()
    button.textContent = running ? 'Pause' : 'Run'
    button.classList.toggle('btn-next', !running)
    button.setAttribute('aria-pressed', running ? 'true' : 'false')
  }

  function watchRecorderSize() {
    const visual = document.querySelector('#recorder-visual')
    if (!visual || typeof ResizeObserver === 'undefined') return
    if (!recorderResizeObserver) {
      recorderResizeObserver = new ResizeObserver(() => {
        if (recording.recorderMode() === 'recording') recording.paintRecording()
        else if (recording.recorderMode() === 'playback') recording.paintPlayback()
      })
    }
    recorderResizeObserver.disconnect()
    recorderResizeObserver.observe(visual)
  }

  function bindSheet() {
    document.querySelector('#run')?.addEventListener('click', toggleRun)
    document.querySelector('#rec')?.addEventListener('click', () => {
      void recording.toggleRecording()
    })
    document.querySelector('#rec-stage')?.addEventListener('click', () => {
      void recording.toggleRecording()
    })
    document.querySelector('#rec-with-run')?.addEventListener('change', recording.onRecWithRunChange)
    document.querySelector('#mic-idle')?.addEventListener('change', recording.onMicChange)
    document.querySelector('#recorder-mic')?.addEventListener('change', recording.onMicChange)
    recording.renderMicSelects()
    document.querySelector('#recorder-stop')?.addEventListener('click', () => {
      void recording.finishRecording()
    })
    document.querySelector('#recorder-pause')?.addEventListener('click', () => {
      if (recording.recorderPaused()) recording.resumeRecordingFromPanel()
      else recording.pauseRecordingFromPanel()
    })
    document.querySelector('#recorder-play')?.addEventListener('click', () => {
      recording.togglePlayback()
    })
    document.querySelector('#recorder-close')?.addEventListener('click', () => {
      recording.closeRecorderPanel()
    })
    recording.bindWavePointer()
    document.querySelector('#to-top')?.addEventListener('click', toTop)
    document.querySelector('#fullscreen')?.addEventListener('click', () => {
      toggleFullscreen()
    })
    document.querySelector('#speed')?.addEventListener('input', (event) => {
      setSpeed(Number(event.target.value))
    })
    document.querySelector('#font-size')?.addEventListener('input', (event) => {
      applyFontSize(event.target.value)
    })
    document.querySelector('#text-view')?.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        const stage = document.querySelector('#text-view')
        scrollBy(wheelDistance(event.deltaMode, event.deltaY, stage?.clientHeight || 0))
      },
      { passive: false },
    )
  }

  function renderSheet() {
    const sheet = document.querySelector('.sheet')
    const essay = current()
    activeIndex = -1
    disconnectView()
    if (!sheet) return
    if (!essay) {
      clearMetrics()
      const message = stageEmptyMessage(folderState())
      sheet.innerHTML = `<p class="empty">${message}</p>`
      void recording.renderTakes()
      recording.noteReaderOpen(false)
      return
    }
    const running = isRunning()
    const speed = getSpeed()
    const fontSize = getFontSize()
    sheet.innerHTML = `
    <div class="head">
      <p class="kicker">${escapeHtml(essay.code)} · ${essay.words} words · ${essay.minutes} min</p>
      <h1>${escapeHtml(essay.title)}</h1>
    </div>
    <div class="read">
      <div class="transport">
        <button class="btn ${running ? '' : 'btn-next'}" id="run" type="button" aria-pressed="${running ? 'true' : 'false'}">${running ? 'Pause' : 'Run'}</button>
        <button class="btn rec" id="rec" type="button" aria-pressed="false" aria-label="Start recording">
          <span class="rec-dot" aria-hidden="true"></span>
          <span>Rec</span>
        </button>
        <label class="rec-with-run">
          <input id="rec-with-run" type="checkbox" ${recording.isRecWithRun() ? 'checked' : ''} />
          Start scrolling with recording
        </label>
        <div class="sliders">
          <label class="speed">
            Speed
            <input id="speed" type="range" min="1" max="50" step="1" value="${speed}" aria-label="Speed" />
            <span id="speed-value">${speed}</span>
          </label>
          <label class="font-size">
            Size
            <input id="font-size" type="range" min="${FONT_MIN}" max="${FONT_MAX}" step="1" value="${fontSize}" aria-label="Font size" />
            <span id="font-size-value">${fontSize}</span>
          </label>
        </div>
        ${recMessageMarkup()}
      </div>
      <div class="mic-row" id="mic-row">
        ${MIC_ICON}
        <select class="mic-select" id="mic-idle" aria-label="Microphone"></select>
      </div>
      <div class="stage-frame" id="stage-frame">
      ${recording.recorderPanelHtml()}
      <div class="stage" id="text-view">
        ${recMessageMarkup('rec-message rec-stage-message')}
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
    recording.resetRulerTrack()
    recording.syncRecUi()
    watchRecorderSize()
    recording.restoreRecorderPanel()
    void recording.renderTakes()
    const stage = document.querySelector('#text-view')
    if (stage) observeView(stage)
    measure()
    restoreIfNeeded()
    applyOffset()
    if (isRunning()) startLoop()
    recording.noteReaderOpen(true)
  }

  return {
    renderSheet,
    updateFocus,
    updateProgress,
    syncRunButton,
    getActiveIndex() {
      return activeIndex
    },
  }
}
