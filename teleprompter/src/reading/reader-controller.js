import { clampOffset, pixelsPerSecond as scrollPixelsPerSecond } from './reader-math.js'

export const SPEED_KEY = 'teleprompter:speed'
export const SPEED_MIN = 1
export const SPEED_MAX = 50
export const SPEED_DEFAULT = 20

export function parseSpeed(raw) {
  try {
    if (raw === null) return SPEED_DEFAULT
    const saved = Number(JSON.parse(raw))
    if (Number.isInteger(saved) && saved >= SPEED_MIN && saved <= SPEED_MAX) return saved
  } catch {
    /* keep the default */
  }
  return SPEED_DEFAULT
}

export function wheelDistance(deltaMode, deltaY, viewHeight) {
  if (deltaMode === 1) return deltaY * 16
  if (deltaMode === 2) return deltaY * (viewHeight || 0)
  return deltaY
}

/**
 * One animation step. Hitting the end while running reports `reachedEnd`
 * so the caller can pause and save. The caller still settles a leftover glide.
 */
export function advanceReading({ offset, running, wheelLeft, dt, rate, limit }) {
  let nextOffset = offset
  let nextWheel = wheelLeft
  let nextRunning = running
  let reachedEnd = false
  if (nextRunning) nextOffset += rate * dt
  if (Math.abs(nextWheel) > 0.5) {
    const step = nextWheel * (1 - Math.exp(-dt / 0.16))
    nextWheel -= step
    nextOffset += step
  }
  if (nextOffset >= limit) {
    nextOffset = limit
    nextWheel = Math.min(0, nextWheel)
    if (nextRunning) {
      nextRunning = false
      reachedEnd = true
    }
  } else if (nextOffset < 0) {
    nextOffset = 0
    nextWheel = Math.max(0, nextWheel)
  }
  return { offset: nextOffset, wheelLeft: nextWheel, running: nextRunning, reachedEnd }
}

export function createReaderController({
  readStorage,
  writeStorage,
  getCurrent,
  layout,
  progress,
  view,
  syncRecorderToRun,
  toggleRecording,
  onEscape,
  toggleFullscreen,
}) {
  let running = false
  let speed = parseSpeed(readStorage(SPEED_KEY))
  let offset = 0
  let raf = 0
  let lastTime = 0
  let wheelLeft = 0

  function pixelsPerSecond() {
    return scrollPixelsPerSecond(speed)
  }

  function isRunning() {
    return running
  }

  function getOffset() {
    return offset
  }

  function setOffset(value) {
    offset = value
  }

  function setRunning(value) {
    running = value
  }

  function setWheelLeft(value) {
    wheelLeft = value
  }

  function getSpeed() {
    return speed
  }

  function applyOffset() {
    layout.reanchor()
    const script = document.querySelector('#text-script')
    if (script) script.style.transform = `translateY(${-offset}px)`
    view.updateFocus()
    layout.captureAnchor()
    view.updateProgress()
  }

  function stopLoop() {
    cancelAnimationFrame(raf)
    raf = 0
    lastTime = 0
  }

  function tick(now) {
    const gliding = Math.abs(wheelLeft) > 0.5
    if (!running && !gliding) {
      stopLoop()
      return
    }
    if (!lastTime) lastTime = now
    const dt = Math.min(0.05, (now - lastTime) / 1000)
    lastTime = now
    const step = advanceReading({
      offset,
      running,
      wheelLeft,
      dt,
      rate: pixelsPerSecond(),
      limit: layout.maxOffset(),
    })
    offset = step.offset
    wheelLeft = step.wheelLeft
    running = step.running
    if (step.reachedEnd) {
      view.syncRunButton()
      progress.saveProgressNow()
      // The last line stops the scroll only. Recording keeps going until Stop.
    }
    applyOffset()
    progress.scheduleSave()
    if (!running && Math.abs(wheelLeft) <= 0.5) {
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

  function scrollBy(distance) {
    if (!distance) return
    const limit = layout.maxOffset()
    const destination = clampOffset(offset + wheelLeft + distance, limit)
    wheelLeft = destination - offset
    if (!raf) startLoop()
  }

  function toTop() {
    running = false
    view.syncRunButton()
    syncRecorderToRun()
    wheelLeft = -offset
    if (Math.abs(wheelLeft) <= 0.5) {
      wheelLeft = 0
      offset = 0
      applyOffset()
      stopLoop()
      progress.scheduleSave()
      return
    }
    if (!raf) startLoop()
  }

  // With "Start scrolling with recording" on, MediaRecorder pauses and resumes
  // with Run. With it off, scrolling leaves the recorder alone, except a pause
  // the reader started from the panel (manualHold) stays paused.

  function pauseRun() {
    if (!running) {
      syncRecorderToRun()
      return
    }
    running = false
    view.syncRunButton()
    progress.saveProgressNow()
    if (Math.abs(wheelLeft) <= 0.5) stopLoop()
    syncRecorderToRun()
  }

  function playRun() {
    const essay = getCurrent()
    if (!essay?.body) return false
    if (running) {
      syncRecorderToRun()
      return true
    }
    if (offset >= layout.maxOffset() - 1) {
      offset = 0
      applyOffset()
    }
    running = true
    view.syncRunButton()
    startLoop()
    syncRecorderToRun()
    return true
  }

  function toggleRun() {
    if (running) pauseRun()
    else playRun()
  }

  function setSpeed(next) {
    speed = next
    writeStorage(SPEED_KEY, JSON.stringify(next))
    const label = document.querySelector('#speed-value')
    if (label) label.textContent = String(next)
    view.updateProgress()
  }

  function remeasureWhenFontsReady() {
    if (!document.fonts?.ready) return
    document.fonts.ready.then(() => {
      const saved = progress.takeFontAnchor()
      layout.measure()
      if (saved && Number.isInteger(saved.index)) {
        layout.setAnchor({ index: saved.index, fraction: saved.fraction, width: -1, height: -1 })
      }
      applyOffset()
    })
  }

  function isTypingTarget(target) {
    return (
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable ||
      (target instanceof HTMLInputElement && ['search', 'text', 'checkbox'].includes(target.type))
    )
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (event) => {
      if (document.querySelector('dialog[open]')) return
      if (event.target instanceof Element && event.target.closest('.row-menu')) return
      const typing = isTypingTarget(event.target)
      if (event.key === 'Escape') {
        onEscape()
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
  }

  return {
    isRunning,
    getOffset,
    setOffset,
    setRunning,
    setWheelLeft,
    getSpeed,
    pixelsPerSecond,
    applyOffset,
    stopLoop,
    startLoop,
    scrollBy,
    toTop,
    pauseRun,
    playRun,
    toggleRun,
    setSpeed,
    remeasureWhenFontsReady,
    bindKeyboard,
  }
}
