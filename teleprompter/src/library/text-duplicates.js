export function normalizedText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim()
}

export function sameTextContent(left, right) {
  return normalizedText(left.title) === normalizedText(right.title)
    && normalizedText(left.body) === normalizedText(right.body)
}
