import { asImportEssay } from './content-selection.js'
import { newImportId, parseImportedText, validateImportBody, keptImportBody, resolvedImportTitle, readingPlaceAfterEdit } from './import-store.js'
import { nextImportCode, textExtension } from './texts-catalog.js'
import { sameTextContent } from './text-duplicates.js'

export function createLibrary({ bundledEssays, loadJSON, texts, deps }) {
  let items = []
  let selected = null
  let query = ''
  let busy = false
  let bootMessage = ''

  function current() {
    const index = items.findIndex(item => item.id === selected)
    return index < 0 ? undefined : asImportEssay(items[index], index)
  }
  function resetReader() {
    deps.setRunning(false)
    deps.setWheelLeft(0)
    deps.stopLoop()
    deps.setOffset(0)
    deps.setAnchor(null)
  }
  function render() {
    deps.renderList()
    deps.renderSheet()
    deps.saveProgressNow()
  }
  function restoreEssay() {
    const saved = loadJSON('teleprompter:essay')
    const key = saved?.id || saved?.file
    selected = items.find(item => item.id === key)?.id || items[0]?.id || null
  }
  function selectImport(id) {
    if (!items.some(item => item.id === id)) return
    void deps.stopRecordingAndSave({ openAfter: false })
    if (selected !== id) deps.closeRecorderPanel()
    selected = id
    resetReader()
    deps.setDrawer(false)
    render()
  }
  function adopt(next) {
    const previous = current()
    items = next
    if (!items.some(item => item.id === selected)) {
      void deps.stopRecordingAndSave({ openAfter: false })
      selected = items[0]?.id || null
      resetReader()
    }
    const after = current()
    if (previous && after && previous.id === after.id && previous.body !== after.body) {
      const place = deps.capturedReadingPlace()
      const nextPlace = readingPlaceAfterEdit({ bodyChanged: true, body: after.body, ...place })
      if (nextPlace) deps.placeReading(nextPlace.index, nextPlace.fraction)
      else { deps.setOffset(0); deps.setAnchor(null) }
    }
    render()
  }
  const message = error => String(error?.message || error || 'Could not access the library folder.')

  async function reload({ manual = false } = {}) {
    if (busy || deps.isEditing?.()) return
    busy = true
    try {
      if (manual) await texts.allow()
      let migrationError = ''
      if (manual) {
        try { await texts.migrate(bundledEssays) } catch (error) { migrationError = message(error) }
      }
      const next = await texts.list()
      // Focus and watcher notifications should not interrupt playback or reading
      // when the on-disk contents have not changed.
      if (JSON.stringify(next) !== JSON.stringify(items)) adopt(next)
      deps.setLoadError(migrationError)
    } catch (error) {
      deps.setLoadError(`${message(error)} Use Folder to choose or reconnect your library.`)
    } finally { busy = false }
  }
  async function chooseFolder() {
    if (busy || deps.isEditing?.()) return
    busy = true
    try {
      await texts.choose()
      await deps.stopRecordingAndSave({ openAfter: false })
      deps.closeRecorderPanel()
      items = []
      selected = null
      resetReader()
      deps.updateFolderChrome()
      render()
      let migrationError = ''
      try { await texts.migrate(bundledEssays) } catch (error) { migrationError = message(error) }
      adopt(await texts.list())
      deps.setLoadError(migrationError)
    } catch (error) {
      if (error?.name !== 'AbortError') deps.setLoadError(message(error))
    } finally { busy = false }
  }
  async function bootTexts() {
    try {
      await texts.boot()
      if (texts.folder) {
        try { await texts.migrate(bundledEssays) } catch (error) { bootMessage = message(error) }
        items = await texts.list()
      }
    } catch (error) { bootMessage = message(error) }
    texts.watch(() => { void reload() })
  }
  async function addImport(raw, options) {
    if (busy) return { error: 'Please wait for the library to finish updating.' }
    if (!texts.folder) return { error: 'Choose a library folder first.' }
    const parsed = parseImportedText(raw, options)
    if (parsed.error) return parsed
    busy = true
    try {
      await texts.allow()
      items = await texts.list()
      const duplicate = items.find(item => sameTextContent(item, parsed))
      if (duplicate) {
        deps.showNotice('This text is already in your library.')
        return { item: duplicate }
      }
      const record = {
        ...parsed, id: newImportId(), code: nextImportCode(items),
        createdAt: new Date().toISOString(), extension: textExtension({ fileName: options?.fileName }),
      }
      await texts.write(record)
      const saved = await texts.read(record.id)
      if (!sameTextContent(saved, record)) throw new Error('Could not verify the saved text.')
      items = await texts.list()
      deps.renderList()
      return { item: saved }
    } catch (error) { return { error: message(error) } }
    finally { busy = false }
  }
  async function updateImport(id, titleValue, bodyValue, fileMeta = {}) {
    if (busy) return { error: 'Please wait for the library to finish updating.' }
    const existing = items.find(item => item.id === id)
    if (!existing) return { error: 'That text was not found.' }
    const validated = validateImportBody(bodyValue, fileMeta)
    if (validated.error) return validated
    const body = keptImportBody(existing.body, bodyValue, validated.text)
    const title = resolvedImportTitle(titleValue, body, fileMeta.fileName || '')
    busy = true
    try {
      await texts.allow()
      const disk = await texts.read(id)
      if (!sameTextContent(disk, existing)) return { error: 'This file changed outside the app. Cancel and refresh before editing it again.' }
      const record = { ...existing, title, body, updatedAt: new Date().toISOString() }
      await texts.write(record)
      const saved = await texts.read(id)
      if (!sameTextContent(saved, record)) throw new Error('Could not verify the saved text.')
      adopt(await texts.list())
      return { item: saved }
    } catch (error) { return { error: message(error) } }
    finally { busy = false }
  }
  async function deleteImport(id) {
    if (busy) return
    const item = items.find(item => item.id === id)
    if (!item) return
    busy = true
    try {
      if (!await deps.askConfirm({ title: 'Delete text?', message: `Delete "${item.title}"? This removes its file from the library folder.` })) return
      await texts.allow()
      if (id === selected) await deps.stopRecordingAndSave({ openAfter: false })
      await texts.remove(id)
      adopt(await texts.list())
      deps.setLoadError('')
    } catch (error) { deps.setLoadError(message(error)) }
    finally { busy = false }
  }
  return {
    get imports() { return items },
    get importId() { return selected },
    get kind() { return 'import' },
    get folderHandle() { return texts.folder },
    get folderName() { return texts.folder?.path || texts.folder?.name || '' },
    get folderNeedsGesture() { return false },
    get bootMessage() { return bootMessage },
    clearBootMessage() { bootMessage = '' },
    get query() { return query },
    setQuery(value) { query = value },
    current, restoreEssay, selectImport, bootTexts, chooseFolder, addImport, updateImport, deleteImport,
    reloadEssays: () => reload({ manual: true }),
  }
}
