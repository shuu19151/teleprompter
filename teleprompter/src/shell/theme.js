const THEME_KEY = 'teleprompter:theme'
const LEGACY_THEME_KEY = 'office-essay:theme'

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

export function setTheme(next) {
  if (next === 'dark') document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
  writeThemeStorage(JSON.stringify(next))
  const button = document.querySelector('#theme')
  if (button) button.textContent = next === 'dark' ? 'Light' : 'Dark'
  // Moved with setTheme. colorCache is private to recorder-ui.js, so this
  // assignment still throws and the repaint below does not run.
  colorCache = { theme: '', ink: '', line: '' }
  if (recorderMode() === 'recording') paintRecording()
  else if (recorderMode() === 'playback') paintPlayback()
}

export function bindThemeToggle() {
  document.querySelector('#theme').addEventListener('click', () => {
    setTheme(theme() === 'dark' ? 'light' : 'dark')
  })
}
