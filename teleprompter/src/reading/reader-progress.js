import { positionStorageRecord } from '../library/content-selection.js'

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
