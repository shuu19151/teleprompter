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
