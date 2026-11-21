import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import './style.css'

const THEME_KEY = 'teleprompter:theme'
const SPEED_KEY = 'teleprompter:speed'
const ESSAY_KEY = 'teleprompter:essay'
const POSITION_KEY = 'teleprompter:position'
const SAVE_DELAY = 300
const LEGACY_KEYS = {
  [THEME_KEY]: 'office-essay:theme',
  [SPEED_KEY]: 'office-essay:speed',
}

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
    code,
    file,
    title: titleCase(title),
    body,
    words,
    minutes: Math.max(1, Math.round(words / 130)),
  }
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

let essays = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, raw]) => parseEssay(path, raw))

const state = {
  index: 0,
  query: '',
  drawer: false,
  running: false,
  speed: loadSpeed(),
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
let saveTimer = 0

function pixelsPerSecond() {
  return state.speed * 2.5
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
  const focusY = state.offset + offsetCache.height / 2 - offsetCache.focusShift
  const next = findActiveIndex(focusY)
  if (next === activeIndex) return
  paintFocus(next)
}

function reanchor() {
  if (!anchor || !lineMetrics.length) return
  if (anchor.width === offsetCache.width && anchor.height === offsetCache.height) return
  const metric = lineMetrics[anchor.index]
  if (!metric) return
  const target = metric.top + anchor.fraction * metric.height - offsetCache.height / 2
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
    fraction: (state.offset + offsetCache.height / 2 - metric.top) / (metric.height || 1),
    width: offsetCache.width,
    height: offsetCache.height,
  }
}

function applyOffset() {
  reanchor()
  const script = document.querySelector('#text-script')
  if (script) script.style.transform = `translateY(${-state.offset}px)`
  updateFocus()
  captureAnchor()
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

function saveProgress() {
  const essay = current()
  if (!essay) return
  writeStorage(ESSAY_KEY, JSON.stringify({ file: essay.file, code: essay.code }))
  const metric = lineMetrics[activeIndex]
  if (metric && offsetCache.height) {
    const fraction = (state.offset + offsetCache.height / 2 - metric.top) / (metric.height || 1)
    writeStorage(POSITION_KEY, JSON.stringify({ index: activeIndex, fraction }))
    return
  }
  writeStorage(POSITION_KEY, JSON.stringify({ offset: state.offset }))
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

function current() {
  return essays[state.index]
}

function restoreEssay() {
  const saved = loadJSON(ESSAY_KEY)
  if (!saved || typeof saved !== 'object') return
  const byFile = essays.findIndex((item) => item.file === saved.file)
  if (byFile !== -1) {
    state.index = byFile
    return
  }
  const byCode = essays.findIndex((item) => item.code === saved.code)
  if (byCode !== -1) state.index = byCode
}

function restorePosition() {
  const saved = loadJSON(POSITION_KEY)
  if (!saved || typeof saved !== 'object') return
  if (
    Number.isInteger(saved.index) &&
    saved.index >= 0 &&
    saved.index < lineMetrics.length &&
    Number.isFinite(saved.fraction)
  ) {
    const metric = lineMetrics[saved.index]
    const target = metric.top + saved.fraction * metric.height - offsetCache.height / 2
    state.offset = Math.min(offsetCache.max, Math.max(0, target))
    return
  }
  if (Number.isFinite(saved.offset)) {
    state.offset = Math.min(offsetCache.max, Math.max(0, saved.offset))
  }
}

async function reloadEssays() {
  const response = await fetch('/api/essays', { cache: 'no-store' })
  if (!response.ok) return
  const data = await response.json()
  const next = data
    .map((item) => parseEssay(item.file, item.text))
    .sort((a, b) => a.file.localeCompare(b.file))
  const currentFile = essays[state.index]?.file
  essays = next
  const found = essays.findIndex((item) => item.file === currentFile)
  if (found === -1) {
    state.index = 0
    state.offset = 0
    wheelLeft = 0
    state.running = false
    anchor = null
    stopLoop()
  } else {
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
}

function select(index) {
  const changed = state.index !== index
  state.running = false
  wheelLeft = 0
  stopLoop()
  state.index = index
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

function setDrawer(open) {
  state.drawer = open
  document.querySelector('.window')?.classList.toggle('is-drawer', open)
}

function renderList() {
  const list = filtered()
  const ul = document.querySelector('#essay-list')
  if (!ul) return
  ul.innerHTML = list.length
    ? list
        .map(
          ({ essay: item, index }) => `
        <li>
          <button class="lesson ${index === state.index ? 'is-on' : ''}" type="button" data-index="${index}">
            <span class="code">${item.code}</span>
            <span class="name">${escapeHtml(item.title)}</span>
          </button>
        </li>`,
        )
        .join('')
    : '<li class="empty">No lesson matches.</li>'
}

function bindSheet() {
  document.querySelector('#run')?.addEventListener('click', toggleRun)
  document.querySelector('#to-top')?.addEventListener('click', toTop)
  document.querySelector('#speed')?.addEventListener('input', (event) => {
    const next = Number(event.target.value)
    state.speed = next
    writeStorage(SPEED_KEY, JSON.stringify(next))
    const label = document.querySelector('#speed-value')
    if (label) label.textContent = String(next)
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
      <p class="kicker">${essay.code} · ${essay.words} words · ${essay.minutes} min</p>
      <h1>${escapeHtml(essay.title)}</h1>
    </div>
    <div class="read">
      <div class="transport">
        <button class="btn ${state.running ? '' : 'btn-next'}" id="run" type="button">${state.running ? 'Pause' : 'Run'}</button>
        <label class="speed">
          Speed
          <input id="speed" type="range" min="1" max="50" step="1" value="${state.speed}" aria-label="Speed" />
          <span id="speed-value">${state.speed}</span>
        </label>
      </div>
      <div class="stage" id="text-view">
        <div class="script" id="text-script">${renderLines(essay.body)}</div>
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
        <button class="menu" id="menu" type="button" aria-label="Essays">Menu</button>
        <div class="brand">Telepromter</div>
        <label class="search">
          <span class="sr">Search essays</span>
          <input id="search" type="search" placeholder="Search essays" value="${escapeAttr(state.query)}" />
        </label>
        <button class="tool" id="theme" type="button">${theme() === 'dark' ? 'Light' : 'Dark'}</button>
      </header>
      <div class="body">
        <aside class="sidebar" id="sidebar">
          <div class="side-head">
            <p class="side-label">Essays</p>
            <button class="tool reload" id="reload" type="button" aria-label="Reload essays">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-2.6-6.3" />
                <path d="M21 4v5h-5" />
              </svg>
            </button>
          </div>
          <ul id="essay-list"></ul>
        </aside>
        <button class="backdrop" id="backdrop" type="button" aria-label="Close menu"></button>
        <main class="sheet"></main>
      </div>
    </div>
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
    const button = event.target.closest('.lesson')
    if (!button) return
    select(Number(button.dataset.index))
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
mount()

if (document.fonts?.ready) {
  document.fonts.ready.then(() => {
    const saved = anchor
    measure()
    if (saved) anchor = { index: saved.index, fraction: saved.fraction, width: -1, height: -1 }
    applyOffset()
  })
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgressNow()
})
window.addEventListener('beforeunload', saveProgressNow)

document.addEventListener('keydown', (event) => {
  const target = event.target
  const typing =
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    (target instanceof HTMLInputElement && ['search', 'text'].includes(target.type))
  if (event.key !== ' ' || typing) return
  event.preventDefault()
  if (!event.repeat) toggleRun()
})
