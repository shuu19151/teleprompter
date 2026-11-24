export function itemKey(item) {
  if (!item) return ''
  return item.kind === 'import' ? item.id : item.file
}

export function essayStorageRecord(essay) {
  if (!essay) return null
  const id = itemKey(essay)
  return {
    file: essay.file,
    code: essay.code,
    kind: essay.kind || 'essay',
    id,
  }
}

export function positionStorageRecord({ index, fraction, offset, id, useLine = false } = {}) {
  if (useLine) return { index, fraction, id }
  return { offset, id }
}

/** A position id applies only when it is a string and it matches the open text. A missing id still applies. */
export function positionApplies(saved, key) {
  if (!saved || typeof saved !== 'object') return false
  if (typeof saved.id === 'string' && saved.id !== key) return false
  return true
}

/**
 * Startup selection. A missing import opens the first essay.
 * An essay matches `file`, then `code`. No match leaves the caller unchanged.
 */
export function resolveSelection({ savedSelection, essays, imports }) {
  if (!savedSelection || typeof savedSelection !== 'object') return null
  if (savedSelection.kind === 'import') {
    const id = typeof savedSelection.id === 'string' ? savedSelection.id : savedSelection.file
    if (typeof id === 'string' && imports.some((item) => item.id === id)) {
      return { kind: 'import', importId: id }
    }
    return { kind: 'essay', index: 0, importId: null }
  }
  const byFile = essays.findIndex((item) => item.file === savedSelection.file)
  if (byFile !== -1) return { kind: 'essay', index: byFile }
  const byCode = essays.findIndex((item) => item.code === savedSelection.code)
  if (byCode !== -1) return { kind: 'essay', index: byCode }
  return null
}

export function asImportEssay(item, index) {
  const words = `${item.title}\n${item.body}`.split(/\s+/).filter(Boolean).length
  return {
    kind: 'import',
    id: item.id,
    code: typeof item.code === 'string' && item.code ? item.code : `U${index + 1}`,
    file: item.id,
    title: item.title,
    body: item.body,
    words,
    minutes: Math.max(1, Math.round(words / 130)),
    createdAt: item.createdAt,
  }
}

export function currentReading({ kind, index, importId, essays, imports }) {
  if (kind === 'import') {
    const found = imports.findIndex((item) => item.id === importId)
    if (found !== -1) return asImportEssay(imports[found], found)
  }
  return essays[index]
}

export function openTextKey({ kind, index = 0, importId = null, essays }) {
  return kind === 'import' ? importId : essays[index]?.file
}

export function essayIndexByFile(essays, file) {
  return essays.findIndex((item) => item.file === file)
}

export function filterEssays(essays, query) {
  const q = query.trim().toLowerCase()
  if (!q) return essays.map((essay, index) => ({ essay, index }))
  return essays
    .map((essay, index) => ({ essay, index }))
    .filter(({ essay }) => `${essay.code} ${essay.title}`.toLowerCase().includes(q))
}

export function filterImports(imports, query) {
  const q = query.trim().toLowerCase()
  return imports
    .map((item, index) => ({ item, index, reading: asImportEssay(item, index) }))
    .filter(({ item, reading }) => !q || `${reading.code} ${reading.title} ${item.body}`.toLowerCase().includes(q))
}
