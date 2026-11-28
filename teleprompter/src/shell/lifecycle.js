import { getCurrentWindow } from '@tauri-apps/api/window'

export async function bindWindowClose(onClose) {
  let closing = false
  await getCurrentWindow()
    .onCloseRequested(async (event) => {
      if (closing) {
        event.preventDefault()
        return
      }
      closing = true
      await onClose()
    })
    .catch((error) => console.error('Could not listen for window close requests.', error))
}

export function bindPageLeave(onLeave) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeave()
  })
  window.addEventListener('pagehide', onLeave)
  window.addEventListener('beforeunload', onLeave)
}

export function bindContextMenuBlock() {
  document.addEventListener('contextmenu', (event) => {
    const target = event.target
    if (
      target instanceof Element &&
      target.closest('#text-view, #import-name, #import-body')
    ) {
      return
    }
    event.preventDefault()
  })
}
