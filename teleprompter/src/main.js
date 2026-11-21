import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/literata/latin-400.css'
import '@fontsource/literata/latin-700.css'
import './style.css'
import { isEssayFile } from './essay-files.js'

const THEME_KEY = 'teleprompter:theme'
const SPEED_KEY = 'teleprompter:speed'
const ESSAY_KEY = 'teleprompter:essay'
const POSITION_KEY = 'teleprompter:position'
const FONT_KEY = 'teleprompter:fontSize'
const IMPORTS_KEY = 'teleprompter:imports'
const FONT_MIN = 24
const FONT_MAX = 56
const FONT_DEFAULT = 32
const READING_RATIO = 1 / 3
const SAVE_DELAY = 300
const MAX_IMPORT_BYTES = 200 * 1024
const EMPTY_IMPORT_MESSAGE = 'Paste some text or choose a .txt or .md file.'
const SIZE_IMPORT_MESSAGE = 'That text is larger than 200 KB.'
const TYPE_IMPORT_MESSAGE = 'Choose a .txt or .md file.'
const READ_IMPORT_MESSAGE = 'Could not read that file.'
const QUOTA_IMPORT_MESSAGE = 'Could not save this text because browser storage is full.'
const ENTER_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H4v4"/><path d="M16 4h4v4"/><path d="M4 16v4h4"/><path d="M20 16v4h-4"/></svg>`
const EXIT_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M4 15h5v5"/><path d="M20 15h-5v5"/></svg>`
const LEGACY_KEYS = {
  [THEME_KEY]: 'office-essay:theme',
  [SPEED_KEY]: 'office-essay:speed',
}

// Case-sensitive E*.txt, matching isEssayFile and /api/essays.
const files = import.meta.glob('../../essays/E*.txt', { query: '?raw', import: 'default', eager: true })

const SMALL = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs'])

function titleCase(raw) {
  return raw
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => {
      if (index > 0 && SMALL.has(word)) return word
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

function parseEssay(path, raw) {
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

function textBytes(value) {
  return new TextEncoder().encode(value).length
}

function fileBaseName(name) {
  return String(name ?? '').split(/[/\\]/).pop() ?? ''
}

function isTextFileName(name) {
  return /\.(txt|md)$/i.test(fileBaseName(name))
}

function isMarkdownName(name) {
  return /\.md$/i.test(fileBaseName(name))
}

function prettyFileName(name) {
  const stripped = fileBaseName(name).replace(/\.(txt|md)$/i, '').trim()
  if (!stripped) return ''
  return titleCase(stripped.replace(/[-_]+/g, ' '))
}

function stripMarkdownHeadings(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^#{1,6}(?:[ \t]+|$)/, ''))
    .join('\n')
}

function clampTitle(value) {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (clean.length <= 180) return clean
  return `${clean.slice(0, 179).trimEnd()}…`
}

function newImportId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isQuotaError(error) {
  if (!error) return false
  if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  return error.code === 22 || error.code === 1014
}

function loadImports() {
  const data = loadJSON(IMPORTS_KEY)
  if (!Array.isArray(data)) return []
  return data
    .filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string')
    .map((item) => ({
      id: item.id,
      title: item.title,
      body: item.body,
      createdAt: typeof item.createdAt === 'string' || typeof item.createdAt === 'number' ? item.createdAt : new Date().toISOString(),
    }))
}

function writeImports(list) {
  try {
    localStorage.setItem(IMPORTS_KEY, JSON.stringify(list))
    return { ok: true }
  } catch (error) {
    return { ok: false, quota: isQuotaError(error) }
  }
}

function readTextFile(file) {
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
function parseImportedText(raw, { title = '', fileName = '', markdown = false } = {}) {
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

function readStorage(key) {
  try {
    const value = localStorage.getItem(key)
    if (value !== null) return value
    const legacy = LEGACY_KEYS[key]
    if (!legacy) return null
    const old = localStorage.getItem(legacy)
    if (old === null) return null
    try {
      localStorage.setItem(key, old)
    } catch {
      /* still use the legacy value */
    }
    return old
  } catch {
    return null
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore quota or private mode */
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

function loadSpeed() {
  try {
    const raw = readStorage(SPEED_KEY)
    if (raw === null) return 20
    const saved = Number(JSON.parse(raw))
    if (Number.isInteger(saved) && saved >= 1 && saved <= 50) return saved
  } catch {
    /* keep the default */
  }
  return 20
}

function loadFontSize() {
  const saved = Number(loadJSON(FONT_KEY))
  if (Number.isInteger(saved) && saved >= FONT_MIN && saved <= FONT_MAX) return saved
  return FONT_DEFAULT
}

let essays = Object.entries(files)
  .filter(([path]) => isEssayFile(path))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, raw]) => parseEssay(path, raw))

let imports = loadImports()
let importFileName = ''
let importMarkdown = false
let importReturnFocus = null
let renamingId = null

const state = {
  index: 0,
  kind: 'essay',
  importId: null,
  query: '',
  drawer: false,
  running: false,
  speed: loadSpeed(),
  fontSize: loadFontSize(),
  offset: 0,
}

let raf = 0
let lastTime = 0
let wheelLeft = 0
let anchor = null
let activeIndex = -1
let lineNodes = []
let lineMetrics = []
let offsetCache = { width: 0, height: 0, focusShift: 0, max: 0 }
let needsRestore = true
let restoredAnchor = null
let saveTimer = 0

function pixelsPerSecond() {
  return state.speed * 2.5
}

function readingFromTop() {
  return offsetCache.height * READING_RATIO
}

/** Script-space Y of the guide, one third down the stage. */
function scriptFocusY() {
  return state.offset + readingFromTop() - offsetCache.focusShift
}

function offsetForFraction(top, height, fraction) {
  return top + fraction * height - readingFromTop() + offsetCache.focusShift
}

function fractionAtOffset(top, height) {
  return (scriptFocusY() - top) / (height || 1)
}

function maxOffset() {
  return offsetCache.max
}

function renderLines(body) {
  return body
    .split('\n')
    .map((line) => (line.trim() ? `<p class="line">${escapeHtml(line)}</p>` : '<div class="gap"></div>'))
    .join('')
}

function measure() {
  const view = document.querySelector('#text-view')
  const script = document.querySelector('#text-script')
  if (!view || !script) {
    lineNodes = []
    lineMetrics = []
    offsetCache = { width: 0, height: 0, focusShift: 0, max: 0 }
    return
  }
  // A transform makes the script the offsetParent, matching re-anchor math.
  script.style.transform = `translateY(${-state.offset}px)`
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

function findActiveIndex(focusY) {
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

function paintFocus(next) {
  const start = activeIndex < 0 ? 0 : Math.max(0, Math.min(activeIndex, next) - 1)
  const end = activeIndex < 0 ? lineNodes.length - 1 : Math.min(lineNodes.length - 1, Math.max(activeIndex, next))
  for (let index = start; index <= end; index += 1) {
    const line = lineNodes[index]
    const delta = index - next
    line.classList.toggle('is-active', delta === 0)
    line.classList.toggle('is-past', delta < 0)
    line.classList.toggle('is-near', delta === -1)
  }
  activeIndex = next
}

function updateFocus() {
  if (!lineMetrics.length) return
  const next = findActiveIndex(scriptFocusY())
  if (next === activeIndex) return
  paintFocus(next)
}

function reanchor() {
  if (!anchor || !lineMetrics.length) return
  if (anchor.width === offsetCache.width && anchor.height === offsetCache.height) return
  const metric = lineMetrics[anchor.index]
  if (!metric) return
  const target = offsetForFraction(metric.top, metric.height, anchor.fraction)
  state.offset = Math.min(offsetCache.max, Math.max(0, target))
}

function captureAnchor() {
  const metric = lineMetrics[activeIndex]
  if (!metric) {
    anchor = null
    return
  }
  anchor = {
    index: activeIndex,
    fraction: fractionAtOffset(metric.top, metric.height),
    width: offsetCache.width,
    height: offsetCache.height,
  }
}

function formatRemaining(seconds) {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0))
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes}:${String(secs).padStart(2, '0')} left`
}

function updateProgress() {
  const bar = document.querySelector('#progress-bar')
  const label = document.querySelector('#progress-time')
  if (!bar && !label) return
  const max = offsetCache.max
  const ratio = max > 0 ? Math.min(1, Math.max(0, state.offset / max)) : 0
  if (bar) {
    bar.style.transform = `scaleX(${ratio})`
    bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  }
  if (label) {
    const rate = pixelsPerSecond()
    const seconds = rate > 0 ? Math.max(0, max - state.offset) / rate : 0
    label.textContent = formatRemaining(seconds)
  }
}

function applyOffset() {
  reanchor()
  const script = document.querySelector('#text-script')
  if (script) script.style.transform = `translateY(${-state.offset}px)`
  updateFocus()
  captureAnchor()
  updateProgress()
}

const resizeObserver = new ResizeObserver(() => {
  measure()
  applyOffset()
})

function syncRunButton() {
  const button = document.querySelector('#run')
  if (!button) return
  button.textContent = state.running ? 'Pause' : 'Run'
  button.classList.toggle('btn-next', !state.running)
  button.setAttribute('aria-pressed', state.running ? 'true' : 'false')
}

function stopLoop() {
  cancelAnimationFrame(raf)
  raf = 0
  lastTime = 0
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

function itemKey(item) {
  if (!item) return ''
  return item.kind === 'import' ? item.id : item.file
}

function saveProgress() {
  const essay = current()
  if (!essay) return
  const id = itemKey(essay)
  writeStorage(
    ESSAY_KEY,
    JSON.stringify({
      file: essay.file,
      code: essay.code,
      kind: essay.kind || 'essay',
      id,
    }),
  )
  const metric = lineMetrics[activeIndex]
  if (metric && offsetCache.height) {
    const fraction = fractionAtOffset(metric.top, metric.height)
    writeStorage(POSITION_KEY, JSON.stringify({ index: activeIndex, fraction, id }))
    return
  }
  writeStorage(POSITION_KEY, JSON.stringify({ offset: state.offset, id }))
}

function tick(now) {
  const gliding = Math.abs(wheelLeft) > 0.5
  if (!state.running && !gliding) {
    stopLoop()
    return
  }
  if (!lastTime) lastTime = now
  const dt = Math.min(0.05, (now - lastTime) / 1000)
  lastTime = now
  if (state.running) state.offset += pixelsPerSecond() * dt
  if (gliding) {
    const step = wheelLeft * (1 - Math.exp(-dt / 0.16))
    wheelLeft -= step
    state.offset += step
  }
  const limit = maxOffset()
  if (state.offset >= limit) {
    state.offset = limit
    wheelLeft = Math.min(0, wheelLeft)
    if (state.running) {
      state.running = false
      syncRunButton()
      saveProgressNow()
    }
  } else if (state.offset < 0) {
    state.offset = 0
    wheelLeft = Math.max(0, wheelLeft)
  }
  applyOffset()
  scheduleSave()
  if (!state.running && Math.abs(wheelLeft) <= 0.5) {
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

function wheelDistance(event) {
  const view = document.querySelector('#text-view')
  if (event.deltaMode === 1) return event.deltaY * 16
  if (event.deltaMode === 2) return event.deltaY * (view?.clientHeight || 0)
  return event.deltaY
}

function scrollBy(distance) {
  if (!distance) return
  const limit = maxOffset()
  const destination = Math.min(limit, Math.max(0, state.offset + wheelLeft + distance))
  wheelLeft = destination - state.offset
  if (!raf) startLoop()
}

function toTop() {
  state.running = false
  syncRunButton()
  wheelLeft = -state.offset
  if (Math.abs(wheelLeft) <= 0.5) {
    wheelLeft = 0
    state.offset = 0
    applyOffset()
    stopLoop()
    scheduleSave()
    return
  }
  if (!raf) startLoop()
}

function toggleRun() {
  const essay = current()
  if (!essay?.body) return
  if (state.running) {
    state.running = false
    syncRunButton()
    saveProgressNow()
    if (Math.abs(wheelLeft) <= 0.5) stopLoop()
    return
  }
  if (state.offset >= maxOffset() - 1) {
    state.offset = 0
    applyOffset()
  }
  state.running = true
  syncRunButton()
  startLoop()
}

const app = document.querySelector('#app')

function theme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function setTheme(next) {
  if (next === 'dark') document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
  writeStorage(THEME_KEY, JSON.stringify(next))
  const button = document.querySelector('#theme')
  if (button) button.textContent = next === 'dark' ? 'Light' : 'Dark'
}

function filtered() {
  const q = state.query.trim().toLowerCase()
  if (!q) return essays.map((essay, index) => ({ essay, index }))
  return essays
    .map((essay, index) => ({ essay, index }))
    .filter(({ essay }) => `${essay.code} ${essay.title}`.toLowerCase().includes(q))
}

function asImportEssay(item, index) {
  const words = `${item.title}\n${item.body}`.split(/\s+/).filter(Boolean).length
  return {
    kind: 'import',
    id: item.id,
    code: `U${index + 1}`,
    file: item.id,
    title: item.title,
    body: item.body,
    words,
    minutes: Math.max(1, Math.round(words / 130)),
    createdAt: item.createdAt,
  }
}

function current() {
  if (state.kind === 'import') {
    const index = imports.findIndex((item) => item.id === state.importId)
    if (index !== -1) return asImportEssay(imports[index], index)
  }
  return essays[state.index]
}

function restoreEssay() {
  const saved = loadJSON(ESSAY_KEY)
  if (!saved || typeof saved !== 'object') return
  if (saved.kind === 'import') {
    const id = typeof saved.id === 'string' ? saved.id : saved.file
    if (typeof id === 'string' && imports.some((item) => item.id === id)) {
      state.kind = 'import'
      state.importId = id
      return
    }
    state.kind = 'essay'
    state.index = 0
    state.importId = null
    return
  }
  const byFile = essays.findIndex((item) => item.file === saved.file)
  if (byFile !== -1) {
    state.kind = 'essay'
    state.index = byFile
    return
  }
  const byCode = essays.findIndex((item) => item.code === saved.code)
  if (byCode !== -1) {
    state.kind = 'essay'
    state.index = byCode
  }
}

function restorePosition() {
  const saved = loadJSON(POSITION_KEY)
  if (!saved || typeof saved !== 'object') return
  const key = itemKey(current())
  if (typeof saved.id === 'string' && saved.id !== key) return
  if (
    Number.isInteger(saved.index) &&
    saved.index >= 0 &&
    saved.index < lineMetrics.length &&
    Number.isFinite(saved.fraction)
  ) {
    const metric = lineMetrics[saved.index]
    restoredAnchor = { index: saved.index, fraction: saved.fraction }
    anchor = { index: saved.index, fraction: saved.fraction, width: -1, height: -1 }
    state.offset = Math.min(offsetCache.max, Math.max(0, offsetForFraction(metric.top, metric.height, saved.fraction)))
    return
  }
  if (Number.isFinite(saved.offset)) {
    state.offset = Math.min(offsetCache.max, Math.max(0, saved.offset))
  }
}

function setLoadError(message) {
  const host = document.querySelector('#sidebar')
  if (!host) return
  let note = host.querySelector('#load-error')
  if (!message) {
    note?.remove()
    return
  }
  if (!note) {
    note = document.createElement('p')
    note.id = 'load-error'
    note.className = 'load-error'
    note.setAttribute('role', 'status')
    host.querySelector('.side-head')?.insertAdjacentElement('afterend', note)
  }
  note.textContent = message
}

async function reloadEssays() {
  setLoadError('')
  try {
    const response = await fetch('/api/essays', { cache: 'no-store' })
    if (!response.ok) throw new Error(`status ${response.status}`)
    const data = await response.json()
    if (!Array.isArray(data)) throw new Error('bad payload')
    const next = data
      .filter((item) => item && typeof item.file === 'string' && typeof item.text === 'string' && isEssayFile(item.file))
      .map((item) => parseEssay(item.file, item.text))
      .sort((a, b) => a.file.localeCompare(b.file))
    const keepImport = state.kind === 'import' && imports.some((item) => item.id === state.importId)
    const currentFile = keepImport ? null : essays[state.index]?.file
    essays = next
    if (keepImport) {
      renderList()
      return
    }
    const found = essays.findIndex((item) => item.file === currentFile)
    if (found === -1) {
      state.kind = 'essay'
      state.importId = null
      state.index = 0
      state.offset = 0
      wheelLeft = 0
      state.running = false
      anchor = null
      stopLoop()
    } else {
      state.kind = 'essay'
      state.index = found
    }
    renderList()
    renderSheet()
    const limit = maxOffset()
    if (state.offset > limit) {
      state.offset = limit
      wheelLeft = 0
      applyOffset()
    }
    saveProgressNow()
  } catch {
    setLoadError('Could not reload essays. The list is only available from the dev server.')
  }
}

function selectReading({ kind, index = 0, id = null }) {
  const prevKey = state.kind === 'import' ? state.importId : essays[state.index]?.file
  const nextKey = kind === 'import' ? id : essays[index]?.file
  const changed = prevKey !== nextKey
  state.running = false
  wheelLeft = 0
  stopLoop()
  state.kind = kind
  state.importId = kind === 'import' ? id : null
  if (kind === 'essay') state.index = index
  state.offset = 0
  anchor = null
  setDrawer(false)
  renderList()
  if (changed) renderSheet()
  else {
    applyOffset()
    syncRunButton()
  }
  saveProgressNow()
}

function select(index) {
  if (!Number.isInteger(index) || !essays[index]) return
  selectReading({ kind: 'essay', index })
}

function selectImport(id) {
  if (!imports.some((item) => item.id === id)) return
  selectReading({ kind: 'import', id })
}

function setDrawer(open) {
  state.drawer = open
  document.querySelector('.window')?.classList.toggle('is-drawer', open)
  const menu = document.querySelector('#menu')
  if (menu) menu.setAttribute('aria-expanded', open ? 'true' : 'false')
}

function filteredImports() {
  const q = state.query.trim().toLowerCase()
  return imports
    .map((item, index) => ({ item, index, reading: asImportEssay(item, index) }))
    .filter(({ item, reading }) => !q || `${reading.code} ${reading.title} ${item.body}`.toLowerCase().includes(q))
}

function renderEssayList() {
  const list = filtered()
  const ul = document.querySelector('#essay-list')
  if (!ul) return
  ul.innerHTML = list.length
    ? list
        .map(
          ({ essay: item, index }) => `
        <li>
          <button class="essay ${state.kind !== 'import' && index === state.index ? 'is-on' : ''}" type="button" data-index="${index}">
            <span class="code">${escapeHtml(item.code)}</span>
            <span class="name">${escapeHtml(item.title)}</span>
          </button>
        </li>`,
        )
        .join('')
    : '<li class="empty">No essay matches.</li>'
}

function renderImportList() {
  const ul = document.querySelector('#import-list')
  if (!ul) return
  const list = filteredImports()
  if (!list.length) {
    ul.innerHTML = `<li class="empty">${state.query.trim() ? 'No text matches.' : 'Nothing imported yet.'}</li>`
    return
  }
  ul.innerHTML = list
    .map(({ item, reading }) => {
      const on = state.kind === 'import' && state.importId === item.id
      if (renamingId === item.id) {
        return `
        <li>
          <form class="rename-form" data-rename-form="${escapeAttr(item.id)}">
            <label class="sr" for="rename-${escapeAttr(item.id)}">Rename</label>
            <input id="rename-${escapeAttr(item.id)}" class="rename-input" type="text" maxlength="180" autocomplete="off" value="${escapeAttr(item.title)}" />
            <button class="tool mini" type="submit">Save</button>
            <button class="tool mini" type="button" data-cancel-rename>Cancel</button>
          </form>
          <p class="rename-error" role="alert" hidden></p>
        </li>`
      }
      return `
        <li class="import-row">
          <button class="essay ${on ? 'is-on' : ''}" type="button" data-import-id="${escapeAttr(item.id)}">
            <span class="code">${escapeHtml(reading.code)}</span>
            <span class="name">${escapeHtml(item.title)}</span>
          </button>
          <div class="import-tools">
            <button class="tool mini" type="button" data-rename="${escapeAttr(item.id)}" aria-label="Rename ${escapeAttr(item.title)}">Rename</button>
            <button class="tool mini" type="button" data-delete="${escapeAttr(item.id)}" aria-label="Delete ${escapeAttr(item.title)}">Delete</button>
          </div>
        </li>`
    })
    .join('')
  const input = ul.querySelector('.rename-input')
  if (input && document.activeElement !== input) {
    input.focus()
    const end = input.value.length
    input.setSelectionRange(end, end)
  }
}

function renderList() {
  renderEssayList()
  renderImportList()
}

function syncHeading() {
  const item = current()
  if (!item) return
  const heading = document.querySelector('.sheet h1')
  const kicker = document.querySelector('.kicker')
  if (heading) heading.textContent = item.title
  if (kicker) kicker.textContent = `${item.code} · ${item.words} words · ${item.minutes} min`
}

function showDialogError(message) {
  const note = document.querySelector('#import-error')
  if (!note) return
  note.hidden = false
  note.textContent = message
}

function clearDialogError() {
  const note = document.querySelector('#import-error')
  if (!note) return
  note.hidden = true
  note.textContent = ''
}

function showImportNote(message) {
  const note = document.querySelector('#import-note')
  if (!note) return
  note.hidden = false
  note.textContent = message
}

function clearImportNote() {
  const note = document.querySelector('#import-note')
  if (!note) return
  note.hidden = true
  note.textContent = ''
}

function addImport(raw, options) {
  const parsed = parseImportedText(raw, options)
  if (parsed.error) return parsed
  const item = {
    id: newImportId(),
    title: parsed.title,
    body: parsed.body,
    createdAt: new Date().toISOString(),
  }
  const next = [...imports, item]
  const saved = writeImports(next)
  if (!saved.ok) return { error: saved.quota ? QUOTA_IMPORT_MESSAGE : 'Could not save this text.' }
  imports = next
  clearImportNote()
  return { item }
}

function commitRename(id, value) {
  const title = clampTitle(value)
  const error = document.querySelector('.rename-error')
  if (!title) {
    if (error) {
      error.hidden = false
      error.textContent = 'Enter a title.'
    }
    return
  }
  const next = imports.map((item) => (item.id === id ? { ...item, title } : item))
  const saved = writeImports(next)
  if (!saved.ok) {
    showImportNote(saved.quota ? QUOTA_IMPORT_MESSAGE : 'Could not rename this text.')
    return
  }
  imports = next
  renamingId = null
  clearImportNote()
  renderImportList()
  if (state.kind === 'import' && state.importId === id) {
    syncHeading()
    saveProgressNow()
  }
}

function deleteImport(id) {
  const item = imports.find((entry) => entry.id === id)
  if (!item) return
  if (!window.confirm(`Delete "${item.title}"?`)) return
  const next = imports.filter((entry) => entry.id !== id)
  const saved = writeImports(next)
  if (!saved.ok) {
    showImportNote(saved.quota ? QUOTA_IMPORT_MESSAGE : 'Could not delete this text.')
    return
  }
  imports = next
  if (renamingId === id) renamingId = null
  clearImportNote()
  if (state.kind === 'import' && state.importId === id) {
    if (essays.length) select(0)
    else {
      state.kind = 'essay'
      state.index = 0
      state.importId = null
      state.offset = 0
      anchor = null
      state.running = false
      wheelLeft = 0
      stopLoop()
      renderList()
      renderSheet()
      saveProgressNow()
    }
    return
  }
  renderImportList()
}

function openImportDialog() {
  const dialog = document.querySelector('#import-dialog')
  if (!dialog || dialog.open) return
  importReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : document.querySelector('#import-open')
  importFileName = ''
  importMarkdown = false
  dialog.querySelector('form')?.reset()
  clearDialogError()
  dialog.showModal()
  dialog.querySelector('#import-name')?.focus()
}

function dialogFocusables(dialog) {
  return [...dialog.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((el) => {
    if (el.disabled || el.getAttribute('aria-hidden') === 'true' || el.closest('[hidden]')) return false
    return true
  })
}

async function importDroppedFile(file) {
  if (!file || !isTextFileName(file.name)) {
    openImportDialog()
    showDialogError(TYPE_IMPORT_MESSAGE)
    return
  }
  if (file.size > MAX_IMPORT_BYTES) {
    openImportDialog()
    showDialogError(SIZE_IMPORT_MESSAGE)
    return
  }
  let text = ''
  try {
    text = await readTextFile(file)
  } catch {
    openImportDialog()
    showDialogError(READ_IMPORT_MESSAGE)
    return
  }
  const result = addImport(text, { fileName: file.name, markdown: isMarkdownName(file.name) })
  if (result.error) {
    openImportDialog()
    showDialogError(result.error)
    return
  }
  document.querySelector('#import-dialog')?.close()
  selectImport(result.item.id)
}

function isFileDrag(event) {
  const types = event.dataTransfer?.types
  if (!types) return false
  return [...types].includes('Files')
}

function filesFromTransfer(transfer) {
  const fromList = [...(transfer?.files ?? [])]
  if (fromList.length) return fromList
  return [...(transfer?.items ?? [])]
    .map((item) => (item.kind === 'file' ? item.getAsFile() : null))
    .filter(Boolean)
}

function applyFontSize(next) {
  const size = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(Number(next))))
  if (!Number.isInteger(size)) return
  state.fontSize = size
  writeStorage(FONT_KEY, JSON.stringify(size))
  document.documentElement.style.setProperty('--script-size', `${size}px`)
  const label = document.querySelector('#font-size-value')
  if (label) label.textContent = String(size)
  const input = document.querySelector('#font-size')
  if (input && Number(input.value) !== size) input.value = String(size)
  if (anchor) anchor = { index: anchor.index, fraction: anchor.fraction, width: -1, height: -1 }
  measure()
  applyOffset()
  scheduleSave()
}

function stageEl() {
  return document.querySelector('#text-view')
}

function syncFullscreenButton() {
  const button = document.querySelector('#fullscreen')
  const stage = stageEl()
  if (!button || !stage) return
  const on = stage.classList.contains('is-fullscreen')
  button.setAttribute('aria-pressed', on ? 'true' : 'false')
  button.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen')
  button.innerHTML = on ? EXIT_ICON : ENTER_ICON
}

function setFullscreenMode(on) {
  const stage = stageEl()
  if (!stage) return
  stage.classList.toggle('is-fullscreen', on)
  document.documentElement.classList.toggle('is-reading-fullscreen', on)
  syncFullscreenButton()
  if (anchor) anchor = { index: anchor.index, fraction: anchor.fraction, width: -1, height: -1 }
  measure()
  applyOffset()
}

async function toggleFullscreen() {
  const stage = stageEl()
  if (!stage) return
  const wasOn = document.fullscreenElement === stage || stage.classList.contains('is-fullscreen')
  try {
    if (document.fullscreenElement === stage) await document.exitFullscreen()
    else if (!wasOn) await stage.requestFullscreen()
  } catch {
    /* Headless Chrome and browsers without a display reject the Fullscreen API. */
  }
  if (wasOn) setFullscreenMode(document.fullscreenElement === stage)
  else setFullscreenMode(document.fullscreenElement === stage || document.fullscreenElement == null)
}

function bindSheet() {
  document.querySelector('#run')?.addEventListener('click', toggleRun)
  document.querySelector('#to-top')?.addEventListener('click', toTop)
  document.querySelector('#fullscreen')?.addEventListener('click', () => {
    toggleFullscreen()
  })
  document.querySelector('#speed')?.addEventListener('input', (event) => {
    const next = Number(event.target.value)
    state.speed = next
    writeStorage(SPEED_KEY, JSON.stringify(next))
    const label = document.querySelector('#speed-value')
    if (label) label.textContent = String(next)
    updateProgress()
  })
  document.querySelector('#font-size')?.addEventListener('input', (event) => {
    applyFontSize(event.target.value)
  })
  document.querySelector('#text-view')?.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      scrollBy(wheelDistance(event))
    },
    { passive: false },
  )
}

function renderSheet() {
  const sheet = document.querySelector('.sheet')
  const essay = current()
  activeIndex = -1
  resizeObserver.disconnect()
  if (!sheet) return
  if (!essay) {
    lineNodes = []
    lineMetrics = []
    offsetCache = { width: 0, height: 0, focusShift: 0, max: 0 }
    sheet.innerHTML = '<p class="empty">No essays found. Add an E01-....txt file next to this reader.</p>'
    return
  }
  sheet.innerHTML = `
    <div class="head">
      <p class="kicker">${escapeHtml(essay.code)} · ${essay.words} words · ${essay.minutes} min</p>
      <h1>${escapeHtml(essay.title)}</h1>
    </div>
    <div class="read">
      <div class="transport">
        <button class="btn ${state.running ? '' : 'btn-next'}" id="run" type="button" aria-pressed="${state.running ? 'true' : 'false'}">${state.running ? 'Pause' : 'Run'}</button>
        <div class="sliders">
          <label class="speed">
            Speed
            <input id="speed" type="range" min="1" max="50" step="1" value="${state.speed}" aria-label="Speed" />
            <span id="speed-value">${state.speed}</span>
          </label>
          <label class="font-size">
            Size
            <input id="font-size" type="range" min="${FONT_MIN}" max="${FONT_MAX}" step="1" value="${state.fontSize}" aria-label="Font size" />
            <span id="font-size-value">${state.fontSize}</span>
          </label>
        </div>
      </div>
      <div class="stage" id="text-view">
        <div class="guide" aria-hidden="true"></div>
        <div class="script" id="text-script">${renderLines(essay.body)}</div>
        <div class="progress">
          <div class="progress-track">
            <div class="progress-bar" id="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Reading progress"></div>
          </div>
          <span id="progress-time">0:00 left</span>
        </div>
        <button class="btn fullscreen" id="fullscreen" type="button" aria-pressed="false" aria-label="Enter fullscreen">${ENTER_ICON}</button>
        <button class="btn to-top" id="to-top" type="button" aria-label="To the top">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 19V6" />
            <path d="M6 11l6-6 6 6" />
          </svg>
        </button>
      </div>
    </div>`
  bindSheet()
  const view = document.querySelector('#text-view')
  if (view) resizeObserver.observe(view)
  measure()
  if (needsRestore) {
    needsRestore = false
    restorePosition()
  }
  applyOffset()
  if (state.running) startLoop()
}

function mount() {
  app.innerHTML = `
    <div class="window">
      <header class="topbar">
        <button class="menu" id="menu" type="button" aria-label="Essays" aria-controls="sidebar" aria-expanded="false">Menu</button>
        <div class="brand">Teleprompter</div>
        <label class="search">
          <span class="sr">Search essays and texts</span>
          <input id="search" type="search" placeholder="Search" value="${escapeAttr(state.query)}" />
        </label>
        <button class="tool" id="theme" type="button">${theme() === 'dark' ? 'Light' : 'Dark'}</button>
      </header>
      <div class="body">
        <aside class="sidebar" id="sidebar">
          <div class="side-head">
            <p class="side-label">Essays</p>
            ${
              import.meta.env.DEV
                ? `<button class="tool reload" id="reload" type="button" aria-label="Reload essays">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-2.6-6.3" />
                <path d="M21 4v5h-5" />
              </svg>
            </button>`
                : ''
            }
          </div>
          <ul id="essay-list"></ul>
          <div class="side-head imports-head">
            <p class="side-label" id="imports-label">My texts</p>
            <button class="tool" id="import-open" type="button">Import</button>
          </div>
          <p id="import-note" class="load-error" role="status" hidden></p>
          <ul id="import-list" aria-labelledby="imports-label"></ul>
        </aside>
        <button class="backdrop" id="backdrop" type="button" aria-label="Close menu"></button>
        <main class="sheet"></main>
      </div>
    </div>
    <dialog class="import-dialog" id="import-dialog" aria-labelledby="import-heading">
      <form class="import-form" id="import-form">
        <div class="import-head">
          <h2 id="import-heading">Import text</h2>
          <button class="tool mini" id="import-close" type="button" aria-label="Close">Close</button>
        </div>
        <label class="field">Title
          <input id="import-name" type="text" maxlength="180" autocomplete="off" placeholder="Leave blank to use the first line" />
        </label>
        <label class="field">Text
          <textarea id="import-body" rows="10" placeholder="Paste text here"></textarea>
        </label>
        <label class="field">File
          <input id="import-file" type="file" accept=".txt,.md,text/plain,text/markdown" />
        </label>
        <p class="hint">.txt or .md, UTF-8, up to 200 KB. You can also drop a file on the window.</p>
        <p id="import-error" class="import-error" role="alert" hidden></p>
        <div class="dialog-actions">
          <button class="btn" id="import-cancel" type="button">Cancel</button>
          <button class="btn btn-next" id="import-save" type="submit">Import</button>
        </div>
      </form>
    </dialog>
  `
  document.querySelector('#reload')?.addEventListener('click', () => {
    reloadEssays()
  })
  document.querySelector('#theme').addEventListener('click', () => {
    setTheme(theme() === 'dark' ? 'light' : 'dark')
  })
  document.querySelector('#menu').addEventListener('click', () => {
    setDrawer(!state.drawer)
  })
  document.querySelector('#backdrop').addEventListener('click', () => {
    setDrawer(false)
  })
  document.querySelector('#essay-list').addEventListener('click', (event) => {
    const button = event.target.closest('.essay')
    if (!button) return
    select(Number(button.dataset.index))
  })
  document.querySelector('#import-open').addEventListener('click', openImportDialog)
  const importList = document.querySelector('#import-list')
  importList.addEventListener('click', (event) => {
    if (event.target.closest('[data-cancel-rename]')) {
      renamingId = null
      renderImportList()
      return
    }
    const rename = event.target.closest('[data-rename]')
    if (rename) {
      renamingId = rename.dataset.rename
      clearImportNote()
      renderImportList()
      return
    }
    const del = event.target.closest('[data-delete]')
    if (del) {
      deleteImport(del.dataset.delete)
      return
    }
    const button = event.target.closest('[data-import-id]')
    if (button) selectImport(button.dataset.importId)
  })
  importList.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-rename-form]')
    if (!form) return
    event.preventDefault()
    commitRename(form.dataset.renameForm, form.querySelector('.rename-input')?.value ?? '')
  })
  importList.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && event.target.classList?.contains('rename-input')) {
      event.stopPropagation()
      renamingId = null
      renderImportList()
    }
  })
  const dialog = document.querySelector('#import-dialog')
  const importForm = document.querySelector('#import-form')
  dialog.addEventListener('close', () => {
    const back = importReturnFocus
    importReturnFocus = null
    if (back?.isConnected) back.focus()
    else document.querySelector('#import-open')?.focus()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      return
    }
    if (event.key !== 'Tab') return
    const nodes = dialogFocusables(dialog)
    if (!nodes.length) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  })
  document.querySelector('#import-close').addEventListener('click', () => dialog.close())
  document.querySelector('#import-cancel').addEventListener('click', () => dialog.close())
  importForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const title = document.querySelector('#import-name')?.value ?? ''
    const body = document.querySelector('#import-body')?.value ?? ''
    const result = addImport(body, { title, fileName: importFileName, markdown: importMarkdown })
    if (result.error) {
      showDialogError(result.error)
      return
    }
    dialog.close()
    selectImport(result.item.id)
  })
  document.querySelector('#import-file')?.addEventListener('change', async (event) => {
    const input = event.target
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (!isTextFileName(file.name)) {
      showDialogError(TYPE_IMPORT_MESSAGE)
      return
    }
    if (file.size > MAX_IMPORT_BYTES) {
      showDialogError(SIZE_IMPORT_MESSAGE)
      return
    }
    try {
      const text = await readTextFile(file)
      if (textBytes(text) > MAX_IMPORT_BYTES) {
        showDialogError(SIZE_IMPORT_MESSAGE)
        return
      }
      const box = document.querySelector('#import-body')
      if (box) box.value = text
      importFileName = file.name
      importMarkdown = isMarkdownName(file.name)
      clearDialogError()
    } catch {
      showDialogError(READ_IMPORT_MESSAGE)
    }
  })
  let dragDepth = 0
  app.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepth += 1
    app.classList.add('is-file-drop')
  })
  app.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  })
  app.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) app.classList.remove('is-file-drop')
  })
  app.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepth = 0
    app.classList.remove('is-file-drop')
    const dropped = filesFromTransfer(event.dataTransfer)
    const file = dropped.find((item) => isTextFileName(item.name))
    importDroppedFile(file || dropped[0])
  })
  const search = document.querySelector('#search')
  search.addEventListener('input', () => {
    state.query = search.value
    renderList()
  })
  renderList()
  renderSheet()
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeAttr(value) {
  return escapeHtml(value)
}

readStorage(THEME_KEY)
restoreEssay()
document.documentElement.style.setProperty('--script-size', `${state.fontSize}px`)
mount()

if (document.fonts?.ready) {
  document.fonts.ready.then(() => {
    const saved = restoredAnchor || (anchor && { index: anchor.index, fraction: anchor.fraction })
    restoredAnchor = null
    measure()
    if (saved && Number.isInteger(saved.index)) {
      anchor = { index: saved.index, fraction: saved.fraction, width: -1, height: -1 }
    }
    applyOffset()
  })
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgressNow()
})
window.addEventListener('beforeunload', saveProgressNow)

document.addEventListener('fullscreenchange', () => {
  const stage = stageEl()
  setFullscreenMode(!!stage && document.fullscreenElement === stage)
})

document.addEventListener('keydown', (event) => {
  if (document.querySelector('#import-dialog')?.open) return
  const target = event.target
  const typing =
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    (target instanceof HTMLInputElement && ['search', 'text'].includes(target.type))
  if (event.key === 'Escape') {
    const stage = stageEl()
    if (stage?.classList.contains('is-fullscreen') && document.fullscreenElement !== stage) setFullscreenMode(false)
    return
  }
  if (event.key === ' ') {
    if (typing) return
    event.preventDefault()
    if (!event.repeat) toggleRun()
    return
  }
  if ((event.key === 'f' || event.key === 'F') && !typing && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault()
    toggleFullscreen()
  }
})
