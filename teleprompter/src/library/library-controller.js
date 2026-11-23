import { isEssayFile } from './essay-files.js'
import {
  clearSavedFolder,
  deleteEssayFile,
  folderPermission,
  folderPickerSupported,
  isFolderScopeError,
  loadSavedFolder,
  pickEssayFolder,
  readEssayFiles,
  requestFolderPermission,
  revealEssayFile,
  saveFolderHandle,
} from './essay-folder.js'
import {
  currentReading,
  essayIndexByFile,
  openTextKey,
  resolveSelection,
} from './content-selection.js'
import {
  keptImportBody,
  loadImports,
  newImportId,
  newImportRecord,
  parseEssay,
  parseImportedText,
  readingPlaceAfterEdit,
  resolvedImportTitle,
  updatedImportRecord,
  validateImportBody,
  writeImports,
} from './import-store.js'

const ESSAY_KEY = 'teleprompter:essay'
const QUOTA_IMPORT_MESSAGE = 'Could not save this text because browser storage is full.'

export function createLibrary({ bundledEssays, loadJSON, deps }) {
  let essays = bundledEssays
  let folderHandle = null
  let folderName = ''
  let folderNeedsGesture = false
  let folderBootMessage = ''
  let imports = loadImports()
  let index = 0
  let kind = 'essay'
  let importId = null
  let query = ''

  function current() {
    return currentReading({ kind, index, importId, essays, imports })
  }

  function restoreEssay() {
    const next = resolveSelection({ savedSelection: loadJSON(ESSAY_KEY), essays, imports })
    if (!next) return
    kind = next.kind
    if (next.index !== undefined) index = next.index
    if (Object.prototype.hasOwnProperty.call(next, 'importId')) importId = next.importId
  }

  function updateFolderChrome() {
    deps.updateFolderChrome()
  }

  function renderList() {
    deps.renderList()
  }

  function applyEssayList(next) {
    const keepImport = kind === 'import' && imports.some((item) => item.id === importId)
    const currentFile = keepImport ? null : essays[index]?.file
    essays = next
    updateFolderChrome()
    if (keepImport) {
      renderList()
      return
    }
    // No essay was on screen (the chosen folder was still waiting for a click).
    // Open the saved essay in this list, including its saved line.
    if (!currentFile) {
      void deps.stopRecordingAndSave()
      deps.setRunning(false)
      deps.setWheelLeft(0)
      deps.stopLoop()
      kind = 'essay'
      importId = null
      index = 0
      deps.setOffset(0)
      deps.setAnchor(null)
      restoreEssay()
      renderList()
      deps.renderSheet()
      deps.restorePosition()
      deps.applyOffset()
      deps.saveProgressNow()
      return
    }
    const found = essayIndexByFile(essays, currentFile)
    if (found === -1) {
      void deps.stopRecordingAndSave()
      kind = 'essay'
      importId = null
      index = 0
      deps.setOffset(0)
      deps.setWheelLeft(0)
      deps.setRunning(false)
      deps.setAnchor(null)
      deps.stopLoop()
    } else {
      kind = 'essay'
      index = found
    }
    renderList()
    deps.renderSheet()
    const limit = deps.maxOffset()
    if (deps.getOffset() > limit) {
      deps.setOffset(limit)
      deps.setWheelLeft(0)
      deps.applyOffset()
    }
    deps.saveProgressNow()
  }

  async function essaysFromHandle(handle) {
    const data = await readEssayFiles(handle)
    return data.map((item) => parseEssay(item.file, item.text))
  }

  async function adoptSavedFolder() {
    if (!folderPickerSupported()) return
    const handle = await loadSavedFolder()
    if (!handle) return
    folderHandle = handle
    folderName = handle.name || 'Folder'
    const permission = await folderPermission(handle)
    if (permission === 'prompt') {
      folderNeedsGesture = true
      essays = []
      return
    }
    if (permission !== 'granted') {
      essays = []
      folderBootMessage = 'Could not read that folder.'
      return
    }
    try {
      essays = await essaysFromHandle(handle)
      folderNeedsGesture = false
    } catch {
      essays = []
      folderBootMessage = 'Could not read that folder.'
    }
  }

  async function bootFolder() {
    try {
      await adoptSavedFolder()
    } catch {
      if (folderHandle) folderNeedsGesture = true
    }
  }

  async function reloadEssays() {
    deps.setLoadError('')
    if (folderHandle) {
      try {
        let permission = await folderPermission(folderHandle)
        if (permission !== 'granted' && !folderHandle.path) permission = await requestFolderPermission(folderHandle)
        if (permission === 'missing') {
          deps.setLoadError('Could not read that folder.')
          return
        }
        if (permission !== 'granted') {
          folderNeedsGesture = true
          updateFolderChrome()
          return
        }
        folderNeedsGesture = false
        applyEssayList(await essaysFromHandle(folderHandle))
      } catch {
        deps.setLoadError('Could not read that folder.')
      }
      return
    }
    try {
      const response = await fetch('/api/essays', { cache: 'no-store' })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const data = await response.json()
      if (!Array.isArray(data)) throw new Error('bad payload')
      const next = data
        .filter((item) => item && typeof item.file === 'string' && typeof item.text === 'string' && isEssayFile(item.file))
        .map((item) => parseEssay(item.file, item.text))
        .sort((a, b) => a.file.localeCompare(b.file))
      applyEssayList(next)
    } catch {
      deps.setLoadError('Could not reload essays. The list is only available from the dev server.')
    }
  }

  async function chooseFolder() {
    if (!folderPickerSupported()) {
      deps.setLoadError('This browser cannot open a folder. Use Chrome or Edge at http://127.0.0.1:5173.')
      return
    }
    let handle
    try {
      handle = await pickEssayFolder(folderHandle?.path)
    } catch (error) {
      if (error?.name === 'AbortError') return
      deps.setLoadError('Could not open that folder.')
      return
    }
    folderHandle = handle
    folderName = handle.name || 'Folder'
    folderNeedsGesture = false
    let rememberError = false
    try {
      await saveFolderHandle(handle)
    } catch {
      rememberError = true
    }
    try {
      applyEssayList(await essaysFromHandle(handle))
      deps.setLoadError(rememberError ? 'Could not remember this folder in this browser.' : '')
    } catch {
      deps.setLoadError('Could not read that folder.')
      updateFolderChrome()
    }
  }

  async function showEssayInFolder(essay) {
    try {
      await revealEssayFile(folderHandle, essay.file)
    } catch {
      deps.showNotice('Could not show that file.')
    }
  }

  async function deleteShownEssay(essay) {
    if (!folderHandle || !essay) return
    const label = [essay.code, essay.title].filter(Boolean).join(' ')
    const accepted = await deps.askConfirm({
      title: 'Delete essay?',
      message: label
        ? `Delete "${label}"? This removes the .txt file from the folder.`
        : 'Delete this .txt file from the folder?',
    })
    if (!accepted || !folderHandle) return
    try {
      await deleteEssayFile(folderHandle, essay.file)
    } catch (error) {
      if (isFolderScopeError(error)) {
        folderNeedsGesture = true
        updateFolderChrome()
        return
      }
      deps.setLoadError('Could not delete that essay.')
      return
    }
    deps.setLoadError('')
    try {
      applyEssayList(await essaysFromHandle(folderHandle))
    } catch {
      deps.setLoadError('Could not read that folder.')
    }
  }

  async function useBundledEssays() {
    let forgetError = false
    try {
      await clearSavedFolder()
    } catch {
      forgetError = true
    }
    folderHandle = null
    folderName = ''
    folderNeedsGesture = false
    applyEssayList(bundledEssays)
    deps.setLoadError(forgetError ? 'Could not forget this folder. It may come back on the next visit.' : '')
  }

  function selectReading({ kind: nextKind, index: nextIndex = 0, id = null }) {
    void deps.stopRecordingAndSave({ openAfter: false })
    const prevKey = openTextKey({ kind, index, importId, essays })
    const nextKey = openTextKey({ kind: nextKind, index: nextIndex, importId: id, essays })
    const changed = prevKey !== nextKey
    if (changed) deps.closeRecorderPanel()
    deps.setRunning(false)
    deps.setWheelLeft(0)
    deps.stopLoop()
    kind = nextKind
    importId = nextKind === 'import' ? id : null
    if (nextKind === 'essay') index = nextIndex
    deps.setOffset(0)
    deps.setAnchor(null)
    deps.setDrawer(false)
    renderList()
    if (changed) deps.renderSheet()
    else {
      deps.applyOffset()
      deps.syncRunButton()
    }
    deps.saveProgressNow()
  }

  function select(nextIndex) {
    if (!Number.isInteger(nextIndex) || !essays[nextIndex]) return
    selectReading({ kind: 'essay', index: nextIndex })
  }

  function selectImport(id) {
    if (!imports.some((item) => item.id === id)) return
    selectReading({ kind: 'import', id })
  }

  function addImport(raw, options) {
    const parsed = parseImportedText(raw, options)
    if (parsed.error) return parsed
    const item = newImportRecord({
      id: newImportId(),
      title: parsed.title,
      body: parsed.body,
      createdAt: new Date().toISOString(),
    })
    const next = [...imports, item]
    const saved = writeImports(next)
    if (!saved.ok) return { error: saved.quota ? QUOTA_IMPORT_MESSAGE : 'Could not save this text.' }
    imports = next
    deps.clearImportNote()
    return { item }
  }

  function updateImport(id, titleValue, bodyValue, fileMeta = {}) {
    const existing = imports.find((item) => item.id === id)
    if (!existing) return { error: 'Could not save this text.' }
    const fileName = fileMeta.fileName ?? ''
    const markdown = fileMeta.markdown ?? false
    const validated = validateImportBody(bodyValue, { fileName, markdown })
    if (validated.error) return validated
    // An untouched textarea must round-trip the stored body exactly, even when
    // normalization would otherwise rewrite whitespace.
    const body = keptImportBody(existing.body, bodyValue, validated.text)
    const title = resolvedImportTitle(titleValue, body, fileName)
    const nextItem = updatedImportRecord(existing, { title, body, updatedAt: new Date().toISOString() })
    const next = imports.map((item) => (item.id === id ? nextItem : item))
    const saved = writeImports(next)
    if (!saved.ok) return { error: saved.quota ? QUOTA_IMPORT_MESSAGE : 'Could not save this text.' }
    const bodyChanged = body !== existing.body
    const place = deps.capturedReadingPlace()
    imports = next
    deps.clearImportNote()
    deps.renderImportList()
    if (kind === 'import' && importId === id) {
      const nextPlace = readingPlaceAfterEdit({ bodyChanged, body, index: place.index, fraction: place.fraction })
      if (!nextPlace) {
        deps.setAnchor(null)
        deps.setOffset(0)
      } else {
        deps.placeReading(nextPlace.index, nextPlace.fraction)
      }
      deps.renderSheet()
      deps.saveProgressNow()
    }
    return { item: nextItem }
  }

  async function deleteImport(id) {
    const item = imports.find((entry) => entry.id === id)
    if (!item) return
    const accepted = await deps.askConfirm({
      title: 'Delete text?',
      message: `Delete "${item.title}"?`,
    })
    if (!accepted) return
    const next = imports.filter((entry) => entry.id !== id)
    const saved = writeImports(next)
    if (!saved.ok) {
      deps.showImportNote(saved.quota ? QUOTA_IMPORT_MESSAGE : 'Could not delete this text.')
      return
    }
    imports = next
    deps.clearImportNote()
    if (kind === 'import' && importId === id) {
      if (essays.length) select(0)
      else {
        void deps.stopRecordingAndSave()
        kind = 'essay'
        index = 0
        importId = null
        deps.setOffset(0)
        deps.setAnchor(null)
        deps.setRunning(false)
        deps.setWheelLeft(0)
        deps.stopLoop()
        deps.renderList()
        deps.renderSheet()
        deps.saveProgressNow()
      }
      return
    }
    deps.renderImportList()
  }

  return {
    get essays() {
      return essays
    },
    get imports() {
      return imports
    },
    get folderHandle() {
      return folderHandle
    },
    get folderName() {
      return folderName
    },
    get folderNeedsGesture() {
      return folderNeedsGesture
    },
    get bootMessage() {
      return folderBootMessage
    },
    clearBootMessage() {
      folderBootMessage = ''
    },
    get query() {
      return query
    },
    setQuery(value) {
      query = value
    },
    get kind() {
      return kind
    },
    get index() {
      return index
    },
    get importId() {
      return importId
    },
    current,
    bootFolder,
    restoreEssay,
    reloadEssays,
    chooseFolder,
    useBundledEssays,
    showEssayInFolder,
    deleteShownEssay,
    select,
    selectImport,
    addImport,
    updateImport,
    deleteImport,
  }
}
