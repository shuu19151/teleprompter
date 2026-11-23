export const ENTER_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H4v4"/><path d="M16 4h4v4"/><path d="M4 16v4h4"/><path d="M20 16v4h-4"/></svg>`
export const EXIT_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M4 15h5v5"/><path d="M20 15h-5v5"/></svg>`

export function fullscreenControl(on) {
  return {
    pressed: on ? 'true' : 'false',
    label: on ? 'Exit fullscreen' : 'Enter fullscreen',
    icon: on ? EXIT_ICON : ENTER_ICON,
  }
}

function frameEl() {
  return document.querySelector('#stage-frame')
}

export function createFullscreen({ onLayout }) {
  function syncFullscreenButton() {
    const button = document.querySelector('#fullscreen')
    const frame = frameEl()
    if (!button || !frame) return
    const control = fullscreenControl(frame.classList.contains('is-fullscreen'))
    button.setAttribute('aria-pressed', control.pressed)
    button.setAttribute('aria-label', control.label)
    button.innerHTML = control.icon
  }

  function setFullscreenMode(on) {
    const frame = frameEl()
    if (!frame) return
    frame.classList.toggle('is-fullscreen', on)
    document.documentElement.classList.toggle('is-reading-fullscreen', on)
    syncFullscreenButton()
    onLayout()
  }

  async function toggleFullscreen() {
    const frame = frameEl()
    if (!frame) return
    const wasOn = document.fullscreenElement === frame || frame.classList.contains('is-fullscreen')
    try {
      if (document.fullscreenElement === frame) await document.exitFullscreen()
      else if (!wasOn) await frame.requestFullscreen()
    } catch {
      /* Headless Chrome and browsers without a display reject the Fullscreen API. */
    }
    if (wasOn) setFullscreenMode(document.fullscreenElement === frame)
    else setFullscreenMode(document.fullscreenElement === frame || document.fullscreenElement == null)
  }

  function onEscape() {
    const frame = frameEl()
    if (frame?.classList.contains('is-fullscreen') && document.fullscreenElement !== frame) setFullscreenMode(false)
  }

  function bindChange() {
    document.addEventListener('fullscreenchange', () => {
      const frame = frameEl()
      setFullscreenMode(!!frame && document.fullscreenElement === frame)
    })
  }

  return { toggleFullscreen, onEscape, bindChange }
}
