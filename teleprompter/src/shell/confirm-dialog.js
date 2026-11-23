import { dialogFocusables } from './dialog-focus.js'

export function confirmDialogMarkup() {
  return `    <dialog class="import-dialog confirm-dialog" id="confirm-dialog" aria-labelledby="confirm-heading" aria-describedby="confirm-copy">
      <div class="import-form">
        <div class="import-head">
          <h2 id="confirm-heading">Delete take?</h2>
        </div>
        <p class="confirm-copy" id="confirm-copy"></p>
        <div class="dialog-actions">
          <button class="btn" id="confirm-cancel" type="button">Cancel</button>
          <button class="btn danger" id="confirm-delete" type="button">Delete</button>
        </div>
      </div>
    </dialog>`
}

export function createConfirmDialog() {
  let confirmResolver = null
  let confirmReturnFocus = null

  function askConfirm({ title, message }) {
    const dialog = document.querySelector('#confirm-dialog')
    if (!dialog || dialog.open) return Promise.resolve(false)
    const heading = dialog.querySelector('#confirm-heading')
    const copy = dialog.querySelector('#confirm-copy')
    if (heading) heading.textContent = title
    if (copy) copy.textContent = message
    confirmReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return new Promise((resolve) => {
      confirmResolver = resolve
      dialog.showModal()
      dialog.querySelector('#confirm-cancel')?.focus()
    })
  }

  function bind() {
    const confirmDialog = document.querySelector('#confirm-dialog')
    const confirmCancel = confirmDialog.querySelector('#confirm-cancel')
    const confirmDelete = confirmDialog.querySelector('#confirm-delete')
    confirmDialog.addEventListener('close', () => {
      const resolve = confirmResolver
      confirmResolver = null
      const back = confirmReturnFocus
      confirmReturnFocus = null
      resolve?.(false)
      if (back?.isConnected) back.focus()
    })
    confirmDialog.addEventListener('click', (event) => {
      if (event.target === confirmDialog) confirmDialog.close()
    })
    confirmDialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        return
      }
      if (event.key === 'Enter') {
        if (event.target === confirmDelete) return
        event.preventDefault()
        if (event.target === confirmCancel) confirmDialog.close()
        return
      }
      if (event.key !== 'Tab') return
      const nodes = dialogFocusables(confirmDialog)
      if (!nodes.length) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !confirmDialog.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !confirmDialog.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    })
    confirmCancel.addEventListener('click', () => confirmDialog.close())
    confirmDelete.addEventListener('click', () => {
      const resolve = confirmResolver
      confirmResolver = null
      confirmDialog.close()
      resolve?.(true)
    })
  }

  return { askConfirm, bind, markup: confirmDialogMarkup }
}
