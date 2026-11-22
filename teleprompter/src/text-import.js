const IMPORTS_KEY = 'teleprompter:imports'

export const MAX_IMPORT_BYTES = 200 * 1024
export const EMPTY_IMPORT_MESSAGE = 'Paste some text or choose a .txt or .md file.'
export const SIZE_IMPORT_MESSAGE = 'That text is larger than 200 KB.'

function readStorage(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function loadJSON(key) {
  try {
    const raw = readStorage(key)
    if (raw === null) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const SMALL = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs'])

export function titleCase(raw) {
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => {
      if (index > 0 && SMALL.has(word)) return word
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

export function parseEssay(path, raw) {
  const file = path.split('/').pop()
  const code = file.match(/E\d+/)?.[0] ?? file
  const text = raw.replace(/\r\n/g, '\n').trim()
  const gap = text.indexOf('\n\n')
  const title = gap === -1 ? text : text.slice(0, gap)
  const body = gap === -1 ? '' : text.slice(gap + 2)
  const words = text.split(/\s+/).filter(Boolean).length
  return {
    kind: 'essay',
    code,
    file,
    title: titleCase(title),
    body,
    words,
    minutes: Math.max(1, Math.round(words / 130)),
  }
}

export function textBytes(value) {
  return new TextEncoder().encode(value).length
}

export function fileBaseName(name) {
  return String(name ?? '').split(/[/\\]/).pop() ?? ''
}

export function isTextFileName(name) {
  return /\.(txt|md)$/i.test(fileBaseName(name))
}

export function isMarkdownName(name) {
  return /\.md$/i.test(fileBaseName(name))
}

export function prettyFileName(name) {
  const stripped = fileBaseName(name).replace(/\.(txt|md)$/i, '').trim()
  if (!stripped) return ''
  return titleCase(stripped.replace(/[-_]+/g, ' '))
}

export function stripMarkdownHeadings(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^#{1,6}(?:[ \t]+|$)/, ''))
    .join('\n')
}

export function clampTitle(value) {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (clean.length <= 180) return clean
  return `${clean.slice(0, 179).trimEnd()}…`
}

export function newImportId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function isQuotaError(error) {
  if (!error) return false
  if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  return error.code === 22 || error.code === 1014
}

export function loadImports() {
  const data = loadJSON(IMPORTS_KEY)
  if (!Array.isArray(data)) return []
  return data
    .filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string')
    .map((item) => {
      const stored = {
        id: item.id,
        title: item.title,
        body: item.body,
        createdAt: typeof item.createdAt === 'string' || typeof item.createdAt === 'number' ? item.createdAt : new Date().toISOString(),
      }
      if (typeof item.updatedAt === 'string' || typeof item.updatedAt === 'number') stored.updatedAt = item.updatedAt
      return stored
    })
}

export function writeImports(list) {
  try {
    localStorage.setItem(IMPORTS_KEY, JSON.stringify(list))
    return { ok: true }
  } catch (error) {
    return { ok: false, quota: isQuotaError(error) }
  }
}

export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsText(file, 'UTF-8')
  })
}

/**
 * Same title-block split as parseEssay: text before the first blank line is the
 * title, and the rest is the script. A typed title replaces that block. With no
 * blank line, the first line (or the file name) is the title and the text stays
 * on the stage. Markdown files drop leading # heading marks only.
 */
export function parseImportedText(raw, { title = '', fileName = '', markdown = false } = {}) {
  if (typeof raw !== 'string') return { error: EMPTY_IMPORT_MESSAGE }
  if (textBytes(raw) > MAX_IMPORT_BYTES) return { error: SIZE_IMPORT_MESSAGE }
  let text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (markdown || isMarkdownName(fileName)) text = stripMarkdownHeadings(text)
  text = text.trim()
  if (!text) return { error: EMPTY_IMPORT_MESSAGE }

  const gap = text.indexOf('\n\n')
  const titleBlock = gap === -1 ? text : text.slice(0, gap)
  const script = gap === -1 ? '' : text.slice(gap + 2)
  const given = title.trim()
  let finalTitle = given
  let body = script
  if (!finalTitle) {
    if (script) finalTitle = titleCase(titleBlock)
    else if (prettyFileName(fileName)) {
      finalTitle = prettyFileName(fileName)
      body = text
    } else {
      const firstLine = text.split('\n').find((line) => line.trim())?.trim() ?? ''
      const rest = text.split('\n').slice(1).join('\n').trim()
      finalTitle = firstLine ? titleCase(firstLine) : ''
      body = rest || text
    }
  } else if (!body) {
    body = text
  }
  finalTitle = clampTitle(finalTitle)
  if (!finalTitle) finalTitle = prettyFileName(fileName) || 'Untitled'
  return { title: finalTitle, body }
}

