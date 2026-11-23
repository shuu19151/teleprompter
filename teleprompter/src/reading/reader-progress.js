import { essayStorageRecord, itemKey, positionApplies, positionStorageRecord } from '../library/content-selection.js'
import { restoreOffset } from './reader-math.js'

const ESSAY_KEY = 'teleprompter:essay'
const POSITION_KEY = 'teleprompter:position'
const SAVE_DELAY = 300

/** The place an edit should keep. A negative focus falls back to the anchor, then the top. */
export function capturedPlace(activeIndex, anchor) {
  const index = activeIndex >= 0 ? activeIndex : anchor?.index ?? 0
  const fraction = anchor && anchor.index === index && Number.isFinite(anchor.fraction) ? anchor.fraction : 0
  return { index: Math.max(0, index), fraction }
}

/**
 * One position slot. A measured line is stored as index + fraction.
 * Otherwise the slot is the pixel offset. The two shapes are never combined.
 */
export function savedReadingPosition({ hasLine, index, fraction, offset, id }) {
  if (hasLine) return positionStorageRecord({ index, fraction, id, useLine: true })
  return positionStorageRecord({ offset, id })
}

export function createReaderProgress({
  writeStorage,
  loadJSON,
  current,
  getActiveIndex,
  getLineMetrics,
  getOffsetCache,
  fractionAtOffset,
  getOffset,
  setOffset,
  getAnchor,
  setAnchor,
  readingFromTop,
}) {
  let saveTimer = 0
  let needsRestore = true
  let restoredAnchor = null

  function saveProgress() {
    const essay = current()
    if (!essay) return
    const record = essayStorageRecord(essay)
    writeStorage(ESSAY_KEY, JSON.stringify(record))
    const lineMetrics = getLineMetrics()
    const activeIndex = getActiveIndex()
    const offsetCache = getOffsetCache()
    const metric = lineMetrics[activeIndex]
    const hasLine = Boolean(metric && offsetCache.height)
    const fraction = hasLine ? fractionAtOffset(metric.top, metric.height) : 0
    writeStorage(
      POSITION_KEY,
      JSON.stringify(
        savedReadingPosition({ hasLine, index: activeIndex, fraction, offset: getOffset(), id: record.id }),
      ),
    )
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

  function restorePosition() {
    const saved = loadJSON(POSITION_KEY)
    if (!positionApplies(saved, itemKey(current()))) return
    const offsetCache = getOffsetCache()
    const next = restoreOffset({
      saved,
      lineMetrics: getLineMetrics(),
      max: offsetCache.max,
      readingFromTop: readingFromTop(),
      focusShift: offsetCache.focusShift,
    })
    if (!next) return
    if (next.restoredAnchor) restoredAnchor = next.restoredAnchor
    if (next.anchor) setAnchor(next.anchor)
    setOffset(next.offset)
  }

  function restoreIfNeeded() {
    if (!needsRestore) return
    needsRestore = false
    restorePosition()
  }

  function capturedReadingPlace() {
    return capturedPlace(getActiveIndex(), getAnchor())
  }

  function placeReading(index, fraction) {
    setAnchor({ index, fraction, width: -1, height: -1 })
  }

  function takeFontAnchor() {
    const anchor = getAnchor()
    const saved = restoredAnchor || (anchor && { index: anchor.index, fraction: anchor.fraction })
    restoredAnchor = null
    return saved
  }

  return {
    scheduleSave,
    saveProgressNow,
    restorePosition,
    restoreIfNeeded,
    capturedReadingPlace,
    placeReading,
    takeFontAnchor,
  }
}
