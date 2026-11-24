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
import { nextImportCode, sameImport, textExtension } from './texts-catalog.js'

const ESSAY_KEY = 'teleprompter:essay'
const QUOTA_IMPORT_MESSAGE = 'Could not save this text because browser storage is full.'

function sameImportList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]
    const b = right[i]
    if (!sameImport(a, b)) return false
    if ((a.code || '') !== (b.code || '')) return false
    if ((a.extension || '') !== (b.extension || '')) return false
    if ((a.name || '') !== (b.name || '')) return false
  }
  return true
}

export function createLibrary({ bundledEssays, loadJSON, texts = null, deps }) {
  const files = Boolean(texts?.enabled)
  let essays = bundledEssays
  let folderHandle = null
  let folderName = ''
  let folderNeedsGesture = false
  let folderBootMessage = ''
  let imports = files ? [] : loadImports()
  let index = 0
  let kind = 'essay'
  let importId = null
  let query = ''
  let importsToken = 0
  let reloadHoldUntil = 0

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

  function mergeWithStored(disk) {
    const stored = loadImports()
    if (!stored.length) return disk
    const seen = new Set(disk.map((item) => item.id))
    const rest = stored.filter((item) => item && !seen.has(item.id))
    return rest.length ? [...disk, ...rest] : disk
  }

  function forgetStoredImport(id) {
    const stored = loadImports()
    if (!stored.some((item) => item.id === id)) return
    writeImports(stored.filter((item) => item.id !== id))
  }

  function holdReloads(ms) {
    reloadHoldUntil = Math.max(reloadHoldUntil, Date.now() + ms)
  }

  function reloadsHeld() {
    return Date.now() < reloadHoldUntil
  }

  function showOpenImport(prevOpen, nextOpen) {
    const bodyChanged = prevOpen.body !== nextOpen.body
    const visibleChanged = bodyChanged || prevOpen.title !== nextOpen.title || (prevOpen.code || '') !== (nextOpen.code || '')
    if (!visibleChanged) return
    if (bodyChanged) {
      const place = deps.capturedReadingPlace()
      const nextPlace = readingPlaceAfterEdit({
        bodyChanged,
        body: nextOpen.body,
        index: place.index,
        fraction: place.fraction,
      })
      if (!nextPlace) {
        deps.setAnchor(null)
        deps.setOffset(0)
      } else {
        deps.placeReading(nextPlace.index, nextPlace.fraction)
      }
    }
    deps.renderSheet()
    deps.saveProgressNow()
  }

  function closeDeletedImport() {
    if (essays.length) {
      select(0)
      return
    }
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

  function adoptImports(next) {
    const prev = imports
    if (sameImportList(prev, next)) return
    const openId = kind === 'import' ? importId : null
    imports = next
    if (openId && !next.some((item) => item.id === openId)) {
      closeDeletedImport()
      return
    }
    deps.renderList()
    if (!openId) return
    const prevOpen = prev.find((item) => item.id === openId)
    const nextOpen = next.find((item) => item.id === openId)
    if (prevOpen && nextOpen) showOpenImport(prevOpen, nextOpen)
  }

  async function reloadImports() {
    if (!files || reloadsHeld()) return
    const token = ++importsToken
    try {
      const next = mergeWithStored(await texts.list())
      if (token !== importsToken) return
      deps.clearImportNote()
      adoptImports(next)
    } catch (error) {
      console.error('Could not load texts.', error)
      if (token === importsToken) deps.showImportNote('Could not load texts.')
    }
  }

  async function bootTexts() {
    if (!files) return
    texts.watch(() => {
      void reloadImports()
    })
    try {
      await texts.migrate()
    } catch (error) {
      console.error('Could not migrate texts to Documents.', error)
    }
    try {
      await reloadImports()
    } catch (error) {
      console.error('Could not load texts from Documents.', error)
    }
    if (!imports.length) {
      const stored = loadImports()
      if (stored.length) imports = stored
    }
  }

  async function pullImportsAfterWrite() {
    holdReloads(500)
    const token = ++importsToken
    const listed = mergeWithStored(await texts.list())
    if (token === importsToken) imports = listed
    return listed
  }

  async function addImport(raw, options) {
    const parsed = parseImportedText(raw, options)
    if (parsed.error) return parsed
    const item = newImportRecord({
      id: newImportId(),
      title: parsed.title,
      body: parsed.body,
      createdAt: new Date().toISOString(),
    })
    if (files) {
      const stored = {
        ...item,
        code: nextImportCode(imports),
        extension: textExtension({ fileName: options?.fileName }),
      }
      try {
        await texts.write(stored)
        const listed = await pullImportsAfterWrite()
        const found = listed.find((entry) => entry.id === item.id)
        if (!found || found.title !== item.title || found.body !== item.body) {
          return { error: 'Could not save this text.' }
        }
        deps.clearImportNote()
        return { item: found }
      } catch {
        return { error: 'Could not save this text.' }
      }
    }
    const next = [...imports, item]
    const saved = writeImports(next)
    if (!saved.ok) return { error: saved.quota ? QUOTA_IMPORT_MESSAGE : 'Could not save this text.' }
    imports = next
    deps.clearImportNote()
    return { item }
  }

  async function updateImport(id, titleValue, bodyValue, fileMeta = {}) {
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
    if (files) {
      const stored = {
        ...nextItem,
        code: existing.code || nextImportCode(imports.filter((item) => item.id !== id)),
        extension: textExtension({ fileName, existing: existing.extension }),
      }
      try {
        await texts.write(stored)
        const listed = await pullImportsAfterWrite()
        const found = listed.find((item) => item.id === id)
        if (!found || found.title !== title || found.body !== body) return { error: 'Could not save this text.' }
        forgetStoredImport(id)
        deps.clearImportNote()
        deps.renderImportList()
        if (kind === 'import' && importId === id) showOpenImport(existing, found)
        return { item: found }
      } catch {
        return { error: 'Could not save this text.' }
      }
    }
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
    if (files) {
      try {
        await texts.remove(id)
      } catch {
        deps.showImportNote('Could not delete this text.')
        return
      }
      forgetStoredImport(id)
      holdReloads(500)
      importsToken += 1
      imports = imports.filter((entry) => entry.id !== id)
      deps.clearImportNote()
      if (kind === 'import' && importId === id) {
        closeDeletedImport()
        return
      }
      deps.renderImportList()
      return
    }
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
    bootTexts,
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
