export const FONT_MIN = 24
export const FONT_MAX = 56
export const FONT_DEFAULT = 32

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
