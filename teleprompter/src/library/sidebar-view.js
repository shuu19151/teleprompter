import { filterEssays, filterImports } from './content-selection.js'
import { elementFromEvent, openRowMenu } from '../shared/row-menu.js'

const FOLDER_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h5l2 2h9v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 7V6a1 1 0 0 1 1-1h4l2 2"/></svg>`

export function essayListEmptyMessage({ query, folderNeedsGesture, folderHandle }) {
  if (query.trim()) return 'No essay matches.'
  if (folderNeedsGesture) return 'Allow this folder to show its essays.'
  if (folderHandle) return 'No .txt files in this folder.'
  return 'No essay matches.'
}

export function importListEmptyMessage(query) {
  return query.trim() ? 'No text matches.' : 'Nothing imported yet.'
}

export function stageEmptyMessage({ folderNeedsGesture, folderHandle }) {
  if (folderNeedsGesture) return 'Allow this folder to show its essays.'
  if (folderHandle) return 'No .txt files in this folder.'
  return 'No essays found. Add an E01-....txt file next to this reader.'
}

export function folderGestureMessage({ folderHandle, folderName }) {
  const control = folderHandle?.path ? 'Folder' : 'reload'
  if (folderName) return `Click ${control} to allow reading ${folderName}.`
  return `Click ${control} to allow reading this folder.`
}

export function sidebarMarkup({ dev, folderHandle, folderName }) {
  const reloadHidden = dev || folderHandle ? '' : 'hidden'
  const nameHidden = folderName ? '' : 'hidden'
  const resetHidden = folderHandle ? '' : 'hidden'
  return `        <aside class="sidebar" id="sidebar">
          <div class="side-head">
            <p class="side-label">Essays</p>
            <div class="side-tools">
              <button class="tool reload" id="reload" type="button" aria-label="Reload essays" ${reloadHidden}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 12a9 9 0 1 1-2.6-6.3" />
                  <path d="M21 4v5h-5" />
                </svg>
              </button>
              <button class="tool folder-pick" id="choose-folder" type="button">
                ${FOLDER_ICON}
                Folder
              </button>
            </div>
          </div>
          <p id="folder-name" class="folder-name" ${nameHidden}></p>
          <p id="load-error" class="load-error" role="status" hidden></p>
          <button class="folder-reset" id="use-app-essays" type="button" ${resetHidden}>Use app essays</button>
          <ul id="essay-list"></ul>
          <div class="side-head imports-head">
            <p class="side-label" id="imports-label">My texts</p>
            <button class="tool folder-pick" id="import-open" type="button">Import</button>
          </div>
          <p id="import-note" class="load-error" role="status" hidden></p>
          <ul id="import-list" aria-labelledby="imports-label"></ul>
          <div class="side-head takes-head">
            <p class="side-label" id="takes-label">Takes</p>
          </div>
          <ul id="takes-list" aria-labelledby="takes-label"></ul>
        </aside>`
}

export function createSidebar({ library, escapeHtml, escapeAttr, inTauri, openImportDialog, openEditDialog }) {
  let drawer = false

  function setLoadError(message) {
    const note = document.querySelector('#load-error')
    if (!note) return
    if (!message) {
      note.hidden = true
      note.textContent = ''
      return
    }
    note.hidden = false
    note.textContent = message
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

  function updateFolderChrome() {
    const folderHandle = library.folderHandle
    const folderName = library.folderName
    const reload = document.querySelector('#reload')
    if (reload) reload.hidden = !(import.meta.env.DEV || folderHandle)
    const name = document.querySelector('#folder-name')
    if (name) {
      name.hidden = !folderName
      name.textContent = folderName
      name.title = folderName
    }
    const reset = document.querySelector('#use-app-essays')
    if (reset) reset.hidden = !folderHandle
    if (library.folderNeedsGesture) {
      setLoadError(folderGestureMessage({ folderHandle, folderName }))
    } else if (library.bootMessage) {
      setLoadError(library.bootMessage)
      library.clearBootMessage()
    }
  }

  function setDrawer(open) {
    drawer = open
    document.querySelector('.window')?.classList.toggle('is-drawer', open)
    const menu = document.querySelector('#menu')
    if (menu) menu.setAttribute('aria-expanded', open ? 'true' : 'false')
  }

  function renderEssayList() {
    const list = filterEssays(library.essays, library.query)
    const ul = document.querySelector('#essay-list')
    if (!ul) return
    const empty = essayListEmptyMessage({
      query: library.query,
      folderNeedsGesture: library.folderNeedsGesture,
      folderHandle: library.folderHandle,
    })
    ul.innerHTML = list.length
      ? list
          .map(
            ({ essay: item, index }) => `
        <li>
          <button class="essay ${library.kind !== 'import' && index === library.index ? 'is-on' : ''}" type="button" data-index="${index}">
            <span class="code">${escapeHtml(item.code)}</span>
            <span class="name">${escapeHtml(item.title)}</span>
          </button>
        </li>`,
          )
          .join('')
      : `<li class="empty">${escapeHtml(empty)}</li>`
  }

  function renderImportList() {
    const ul = document.querySelector('#import-list')
    if (!ul) return
    const list = filterImports(library.imports, library.query)
    if (!list.length) {
      ul.innerHTML = `<li class="empty">${importListEmptyMessage(library.query)}</li>`
      return
    }
    ul.innerHTML = list
      .map(({ item, reading }) => {
        const on = library.kind === 'import' && library.importId === item.id
        return `
        <li>
          <button class="essay ${on ? 'is-on' : ''}" type="button" data-import-id="${escapeAttr(item.id)}">
            <span class="code">${escapeHtml(reading.code)}</span>
            <span class="name">${escapeHtml(item.title)}</span>
          </button>
        </li>`
      })
      .join('')
  }

  function renderList() {
    renderEssayList()
    renderImportList()
  }

  function openEssayMenu(button, x, y) {
    const index = Number(button.dataset.index)
    const essay = Number.isInteger(index) ? library.essays[index] : null
    if (!essay) return
    const items = [{ label: 'Open', onSelect: () => library.select(index) }]
    if (library.folderHandle?.path && inTauri()) {
      items.push({
        label: 'Show in folder',
        onSelect: () => {
          void library.showEssayInFolder(essay)
        },
      })
    }
    if (library.folderHandle) {
      items.push({
        label: 'Delete',
        danger: true,
        onSelect: () => {
          void library.deleteShownEssay(essay)
        },
      })
    }
    openRowMenu({ x, y, items, returnFocus: button })
  }

  function onEssayContextMenu(event) {
    const button = elementFromEvent(event)?.closest('.essay')
    if (!button) return
    event.preventDefault()
    openEssayMenu(button, event.clientX, event.clientY)
  }

  function openImportMenu(button, x, y) {
    const id = button.dataset.importId
    if (!id || !library.imports.some((item) => item.id === id)) return
    openRowMenu({
      x,
      y,
      items: [
        { label: 'Edit', onSelect: () => openEditDialog(id) },
        { label: 'Delete', danger: true, onSelect: () => library.deleteImport(id) },
      ],
      returnFocus: button,
    })
  }

  function onImportContextMenu(event) {
    const button = elementFromEvent(event)?.closest('[data-import-id]')
    if (!button) return
    event.preventDefault()
    openImportMenu(button, event.clientX, event.clientY)
  }

  function onImportMenuKey(event) {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    const button = elementFromEvent(event)?.closest('[data-import-id]')
    if (!button) return
    event.preventDefault()
    const rect = button.getBoundingClientRect()
    openImportMenu(button, rect.left, rect.bottom)
  }

  function onEssayMenuKey(event) {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    const button = elementFromEvent(event)?.closest('.essay')
    if (!button) return
    event.preventDefault()
    const rect = button.getBoundingClientRect()
    openEssayMenu(button, rect.left, rect.bottom)
  }

  function markup() {
    return sidebarMarkup({
      dev: import.meta.env.DEV,
      folderHandle: library.folderHandle,
      folderName: library.folderName,
    })
  }

  function bind() {
    document.querySelector('#reload')?.addEventListener('click', () => {
      void library.reloadEssays()
    })
    document.querySelector('#choose-folder')?.addEventListener('click', () => {
      void library.chooseFolder()
    })
    document.querySelector('#use-app-essays')?.addEventListener('click', () => {
      void library.useBundledEssays()
    })
    updateFolderChrome()
    document.querySelector('#menu').addEventListener('click', () => {
      setDrawer(!drawer)
    })
    document.querySelector('#backdrop').addEventListener('click', () => {
      setDrawer(false)
    })
    const essayList = document.querySelector('#essay-list')
    essayList.addEventListener('click', (event) => {
      const button = event.target.closest('.essay')
      if (!button) return
      library.select(Number(button.dataset.index))
    })
    essayList.addEventListener('contextmenu', onEssayContextMenu)
    essayList.addEventListener('keydown', onEssayMenuKey)
    document.querySelector('#import-open').addEventListener('click', openImportDialog)
    const importList = document.querySelector('#import-list')
    importList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-import-id]')
      if (button) library.selectImport(button.dataset.importId)
    })
    importList.addEventListener('contextmenu', onImportContextMenu)
    importList.addEventListener('keydown', onImportMenuKey)
    const search = document.querySelector('#search')
    search.addEventListener('input', () => {
      library.setQuery(search.value)
      renderList()
    })
  }

  return {
    markup,
    bind,
    renderList,
    renderImportList,
    updateFolderChrome,
    setDrawer,
    setLoadError,
    showImportNote,
    clearImportNote,
  }
}
