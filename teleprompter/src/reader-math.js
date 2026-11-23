export const READING_RATIO = 1 / 3

export function pixelsPerSecond(speed) {
  return speed * 2.5
}

export function readingFromTop(height, ratio = READING_RATIO) {
  return height * ratio
}

export function scriptFocusY({ offset, height, focusShift, ratio = READING_RATIO }) {
  return offset + height * ratio - focusShift
}

export function offsetForFraction(top, height, fraction, { readingFromTop: fromTop, focusShift }) {
  return top + fraction * height - fromTop + focusShift
}

export function fractionAtOffset(top, height, focusY) {
  return (focusY - top) / (height || 1)
}

export function findActiveIndex(lineMetrics, focusY) {
  const last = lineMetrics.length - 1
  if (last <= 0) return 0
  if (focusY <= lineMetrics[0].center) return 0
  if (focusY >= lineMetrics[last].center) return last
  let low = 0
  let high = last
  while (low + 1 < high) {
    const mid = (low + high) >> 1
    if (lineMetrics[mid].center <= focusY) low = mid
    else high = mid
  }
  const lowDistance = focusY - lineMetrics[low].center
  const highDistance = lineMetrics[high].center - focusY
  return lowDistance <= highDistance ? low : high
}

export function clampOffset(offset, max) {
  return Math.min(max, Math.max(0, offset))
}

/** Pixel offset that puts the guide back on the anchored line. Null means the anchor does not apply. */
export function anchorOffset({ anchor, metrics, width, height, max, readingFromTop: fromTop, focusShift }) {
  if (!anchor || !metrics.length) return null
  if (anchor.width === width && anchor.height === height) return null
  const metric = metrics[anchor.index]
  if (!metric) return null
  const target = offsetForFraction(metric.top, metric.height, anchor.fraction, {
    readingFromTop: fromTop,
    focusShift,
  })
  return clampOffset(target, max)
}

export function formatRemaining(seconds) {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0))
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes}:${String(secs).padStart(2, '0')} left`
}

export function progressRatio(offset, max) {
  return max > 0 ? Math.min(1, Math.max(0, offset / max)) : 0
}

export function remainingSeconds(offset, max, rate) {
  return rate > 0 ? Math.max(0, max - offset) / rate : 0
}

/**
 * Line form wins when the index is inside the measured lines and the fraction is finite.
 * Otherwise a numeric offset is clamped. Anything else is ignored.
 */
export function restoreOffset({ saved, lineMetrics, max, readingFromTop: fromTop, focusShift }) {
  if (
    Number.isInteger(saved.index) &&
    saved.index >= 0 &&
    saved.index < lineMetrics.length &&
    Number.isFinite(saved.fraction)
  ) {
    const metric = lineMetrics[saved.index]
    const offset = clampOffset(
      offsetForFraction(metric.top, metric.height, saved.fraction, { readingFromTop: fromTop, focusShift }),
      max,
    )
    return {
      offset,
      anchor: { index: saved.index, fraction: saved.fraction, width: -1, height: -1 },
      restoredAnchor: { index: saved.index, fraction: saved.fraction },
    }
  }
  if (Number.isFinite(saved.offset)) return { offset: clampOffset(saved.offset, max) }
  return null
}
