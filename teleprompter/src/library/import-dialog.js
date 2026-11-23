import {
  isMarkdownName,
  isTextFileName,
  MAX_IMPORT_BYTES,
  readTextFile,
  SIZE_IMPORT_MESSAGE,
  textBytes,
} from './import-store.js'
import { dialogFocusables } from '../shell/dialog-focus.js'

const TYPE_IMPORT_MESSAGE = 'Choose a .txt or .md file.'
const READ_IMPORT_MESSAGE = 'Could not read that file.'

export function isFileDrag(event) {
  const types = event.dataTransfer?.types
  if (!types) return false
  return [...types].includes('Files')
}

export function filesFromTransfer(transfer) {
  const fromList = [...(transfer?.files ?? [])]
  if (fromList.length) return fromList
  return [...(transfer?.items ?? [])]
    .map((item) => (item.kind === 'file' ? item.getAsFile() : null))
    .filter(Boolean)
}

export function importDialogMarkup() {
  return `    <dialog class="import-dialog" id="import-dialog" aria-labelledby="import-heading">
      <form class="import-form" id="import-form">
        <div class="import-head">
          <h2 id="import-heading">Import text</h2>
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
    </dialog>`
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

function setDialogMode(mode) {
  const heading = document.querySelector('#import-heading')
  const save = document.querySelector('#import-save')
  if (heading) heading.textContent = mode === 'edit' ? 'Edit text' : 'Import text'
  if (save) save.textContent = mode === 'edit' ? 'Save' : 'Import'
}

export function createImportDialog(deps) {
  let importFileName = ''
  let importMarkdown = false
  let importReturnFocus = null
  let editingId = null
  let dragDepth = 0

  function openImportDialog() {
    const dialog = document.querySelector('#import-dialog')
    if (!dialog || dialog.open) return
    importReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : document.querySelector('#import-open')
    editingId = null
    importFileName = ''
    importMarkdown = false
    dialog.querySelector('form')?.reset()
    clearDialogError()
    setDialogMode('import')
    dialog.showModal()
    dialog.querySelector('#import-name')?.focus()
  }

  function openEditDialog(id) {
    const dialog = document.querySelector('#import-dialog')
    const item = deps.getImports().find((entry) => entry.id === id)
    if (!dialog || dialog.open || !item) return
    importReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    editingId = item.id
    importFileName = ''
    importMarkdown = false
    dialog.querySelector('form')?.reset()
    clearDialogError()
    const name = dialog.querySelector('#import-name')
    const body = dialog.querySelector('#import-body')
    if (name) name.value = item.title
    if (body) body.value = item.body
    setDialogMode('edit')
    dialog.showModal()
    name?.focus()
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
    const result = deps.addImport(text, { fileName: file.name, markdown: isMarkdownName(file.name) })
    if (result.error) {
      openImportDialog()
      showDialogError(result.error)
      return
    }
    document.querySelector('#import-dialog')?.close()
    deps.selectImport(result.item.id)
  }

  function bind() {
    const dialog = document.querySelector('#import-dialog')
    const importForm = document.querySelector('#import-form')
    dialog.addEventListener('close', () => {
      editingId = null
      importFileName = ''
      importMarkdown = false
      dialog.querySelector('form')?.reset()
      clearDialogError()
      setDialogMode('import')
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
    document.querySelector('#import-cancel').addEventListener('click', () => dialog.close())
    importForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const title = document.querySelector('#import-name')?.value ?? ''
      const body = document.querySelector('#import-body')?.value ?? ''
      const id = editingId
      const fileMeta = { fileName: importFileName, markdown: importMarkdown }
      const result = id ? deps.updateImport(id, title, body, fileMeta) : deps.addImport(body, { title, ...fileMeta })
      if (result.error) {
        showDialogError(result.error)
        return
      }
      dialog.close()
      if (!id) deps.selectImport(result.item.id)
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
    const app = document.querySelector('#app')
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
  }

  return { openImportDialog, openEditDialog, bind, markup: importDialogMarkup }
}
