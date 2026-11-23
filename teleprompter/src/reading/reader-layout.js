import {
  READING_RATIO,
  anchorOffset,
  fractionAtOffset as fractionOnLine,
  readingFromTop as guideFromTop,
  scriptFocusY as focusYFor,
} from './reader-math.js'

export const FONT_MIN = 24
export const FONT_MAX = 56
export const FONT_DEFAULT = 32
const FONT_KEY = 'teleprompter:fontSize'

export function parseFontSize(saved) {
  const size = Number(saved)
  if (Number.isInteger(size) && size >= FONT_MIN && size <= FONT_MAX) return size
  return FONT_DEFAULT
}

/** Rounded size inside the slider range. Null when the value is not a finite number. */
export function clampFontSize(next) {
  const size = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(Number(next))))
  if (!Number.isInteger(size)) return null
  return size
}

export function createReaderLayout({ loadJSON, writeStorage, getOffset, setOffset, getActiveIndex, applyOffset, scheduleSave }) {
  let fontSize = parseFontSize(loadJSON(FONT_KEY))
  let anchor = null
  let lineNodes = []
  let lineMetrics = []
  let offsetCache = { width: 0, height: 0, focusShift: 0, max: 0 }

  function readingFromTop() {
    return guideFromTop(offsetCache.height)
  }

  /** Script-space Y of the guide, one third down the stage. */
  function scriptFocusY() {
    return focusYFor({ offset: getOffset(), height: offsetCache.height, focusShift: offsetCache.focusShift })
  }

  function fractionAtOffset(top, height) {
    return fractionOnLine(top, height, scriptFocusY())
  }

  function maxOffset() {
    return offsetCache.max
  }

  function clearMetrics() {
    lineNodes = []
    lineMetrics = []
    offsetCache = { width: 0, height: 0, focusShift: 0, max: 0 }
  }

  function measure() {
    const view = document.querySelector('#text-view')
    const script = document.querySelector('#text-script')
    if (!view || !script) {
      clearMetrics()
      return
    }
    // A transform makes the script the offsetParent, matching re-anchor math.
    script.style.transform = `translateY(${-getOffset()}px)`
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
    setOffset(next)
  }

  function captureAnchor() {
    const metric = lineMetrics[getActiveIndex()]
    if (!metric) {
      anchor = null
      return
    }
    anchor = {
      index: getActiveIndex(),
      fraction: fractionAtOffset(metric.top, metric.height),
      width: offsetCache.width,
      height: offsetCache.height,
    }
  }

  function invalidateAnchor() {
    if (anchor) anchor = { index: anchor.index, fraction: anchor.fraction, width: -1, height: -1 }
  }

  function syncScriptSize() {
    document.documentElement.style.setProperty('--script-size', `${fontSize}px`)
  }

  function applyFontSize(next) {
    const size = clampFontSize(next)
    if (size === null) return
    fontSize = size
    writeStorage(FONT_KEY, JSON.stringify(size))
    document.documentElement.style.setProperty('--script-size', `${size}px`)
    const label = document.querySelector('#font-size-value')
    if (label) label.textContent = String(size)
    const input = document.querySelector('#font-size')
    if (input && Number(input.value) !== size) input.value = String(size)
    invalidateAnchor()
    measure()
    applyOffset()
    scheduleSave()
  }

  const resizeObserver = new ResizeObserver(() => {
    measure()
    applyOffset()
  })

  return {
    getFontSize() {
      return fontSize
    },
    getAnchor() {
      return anchor
    },
    setAnchor(value) {
      anchor = value
    },
    getLineNodes() {
      return lineNodes
    },
    getLineMetrics() {
      return lineMetrics
    },
    getOffsetCache() {
      return offsetCache
    },
    readingFromTop,
    scriptFocusY,
    fractionAtOffset,
    maxOffset,
    clearMetrics,
    measure,
    reanchor,
    captureAnchor,
    invalidateAnchor,
    syncScriptSize,
    applyFontSize,
    observeView(element) {
      resizeObserver.observe(element)
    },
    disconnectView() {
      resizeObserver.disconnect()
    },
  }
}
