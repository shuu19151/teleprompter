import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import './style.css'

const THEME_KEY = 'office-essay:theme'
const SPEED_KEY = 'office-essay:speed'
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

let essays = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, raw]) => parseEssay(path, raw))

function loadSpeed() {
  try {
    const saved = Number(JSON.parse(localStorage.getItem(SPEED_KEY)))
    if (Number.isInteger(saved) && saved >= 1 && saved <= 50) return saved
  } catch {
    /* keep the default */
  }
  return 20
}

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

function pixelsPerSecond() {
  return state.speed * 2.5
}

function maxOffset() {
  const view = document.querySelector('#text-view')
  const script = document.querySelector('#text-script')
  if (!view || !script) return 0
  const style = getComputedStyle(view)
  const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
  return Math.max(0, script.offsetHeight - (view.clientHeight - pad))
}

function renderLines(body) {
  return body
    .split('\n')
    .map((line) => (line.trim() ? `<p class="line">${escapeHtml(line)}</p>` : '<div class="gap"></div>'))
    .join('')
}

function updateFocus() {
  const view = document.querySelector('#text-view')
  const lines = [...document.querySelectorAll('.line')]
  if (!view || !lines.length) return
  const mid = view.getBoundingClientRect().top + view.clientHeight / 2
  let active = 0
  let best = Infinity
  lines.forEach((line, index) => {
    const box = line.getBoundingClientRect()
    const distance = Math.abs(box.top + box.height / 2 - mid)
    if (distance < best) {
      best = distance
      active = index
    }
  })
  lines.forEach((line, index) => {
    const distance = Math.abs(index - active)
    line.classList.toggle('is-active', distance === 0)
    line.classList.toggle('is-near', distance === 1)
    line.classList.toggle('is-mid', distance === 2)
  })
}

function applyOffset() {
  const script = document.querySelector('#text-script')
  if (script) script.style.transform = `translateY(${-state.offset}px)`
  updateFocus()
}

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
    }
  } else if (state.offset < 0) {
    state.offset = 0
    wheelLeft = Math.max(0, wheelLeft)
  }
  applyOffset()
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
  localStorage.setItem(THEME_KEY, JSON.stringify(next))
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
    stopLoop()
  }
  render()
  const limit = maxOffset()
  if (state.offset > limit) {
    state.offset = limit
    wheelLeft = 0
    applyOffset()
  }
}

function select(index) {
  state.running = false
  wheelLeft = 0
  stopLoop()
  state.index = index
  state.offset = 0
  state.drawer = false
  render()
}

function render() {
  const keepSearch = document.activeElement?.id === 'search'
  const essay = current()
  const list = filtered()

  app.innerHTML = `
    <div class="window ${state.drawer ? 'is-drawer' : ''}">
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
          <ul>
            ${
              list.length
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
          </ul>
        </aside>
        <button class="backdrop" id="backdrop" type="button" aria-label="Close menu"></button>
        <main class="sheet">
          ${
            essay
              ? `
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
              : '<p class="empty">No essays found. Add an E01-....txt file next to this reader.</p>'
          }
        </main>
      </div>
    </div>
  `

  const search = document.querySelector('#search')

  document.querySelector('#reload')?.addEventListener('click', () => {
    reloadEssays()
  })
  document.querySelector('#theme').addEventListener('click', () => {
    setTheme(theme() === 'dark' ? 'light' : 'dark')
  })
  document.querySelector('#menu').addEventListener('click', () => {
    state.drawer = !state.drawer
    render()
  })
  document.querySelector('#backdrop').addEventListener('click', () => {
    state.drawer = false
    render()
  })
  document.querySelectorAll('.lesson').forEach((button) => {
    button.addEventListener('click', () => select(Number(button.dataset.index)))
  })
  document.querySelector('#run')?.addEventListener('click', toggleRun)
  document.querySelector('#to-top')?.addEventListener('click', toTop)
  document.querySelector('#speed')?.addEventListener('input', (event) => {
    const next = Number(event.target.value)
    state.speed = next
    localStorage.setItem(SPEED_KEY, JSON.stringify(next))
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
  search.addEventListener('input', () => {
    state.query = search.value
    render()
  })
  if (keepSearch) {
    search.focus()
    const end = search.value.length
    search.setSelectionRange(end, end)
  }
  applyOffset()
  if (state.running) startLoop()
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

document.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
  if (event.key === ' ' && !typing && !(event.target instanceof HTMLButtonElement)) {
    event.preventDefault()
    toggleRun()
  }
})

render()
