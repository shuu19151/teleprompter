const THEME_KEY = 'teleprompter:theme'
const LEGACY_THEME_KEY = 'office-essay:theme'
const SUN = `<svg class="theme-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M18.4 5.6l-1.5 1.5M7.1 16.9l-1.5 1.5"/></svg>`
const MOON = `<svg class="theme-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/></svg>`

export function themeButtonMarkup(mode) {
  return mode === 'dark' ? MOON : SUN
}

function paintThemeButton(mode) {
  const button = document.querySelector('#theme')
  if (!button) return
  button.innerHTML = themeButtonMarkup(mode)
  button.setAttribute('aria-label', mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme')
}

export function readThemeStorage(storage) {
  try {
    const store = storage || localStorage
    const value = store.getItem(THEME_KEY)
    if (value !== null) return value
    const old = store.getItem(LEGACY_THEME_KEY)
    if (old === null) return null
    try {
      store.setItem(THEME_KEY, old)
    } catch {
      /* still use the legacy value */
    }
    return old
  } catch {
    return null
  }
}

export function writeThemeStorage(value, storage) {
  try {
    const store = storage || localStorage
    store.setItem(THEME_KEY, value)
  } catch {
    /* ignore quota or private mode */
  }
}

export function theme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function setTheme(next, hooks = {}) {
  if (next === 'dark') document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
  writeThemeStorage(JSON.stringify(next))
  paintThemeButton(next)
  hooks.onThemeChange?.()
}

export function bindThemeToggle(hooks = {}) {
  document.querySelector('#theme').addEventListener('click', () => {
    setTheme(theme() === 'dark' ? 'light' : 'dark', hooks)
  })
}
