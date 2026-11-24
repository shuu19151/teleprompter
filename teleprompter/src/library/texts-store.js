/**
 * Imported texts. In the Tauri window the list is Documents/Teleprompter/texts.
 * On the Vite page the same sidebar keeps using localStorage, which is what
 * the Playwright smoke test reads.
 */
import { inTauri } from './essay-folder.js'
import { IMPORTS_KEY, clearImports, loadImports, writeImports } from './import-store.js'
import { loadJSON } from '../shared/storage.js'
import {
  assignMigrationCodes,
  filesToImports,
  fileToImport,
  importsAfterMigration,
  migrateStoredImports,
  toTextDraft,
} from './texts-catalog.js'

async function tauriInvoke(command, args) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

export function createTextsStore() {
  const enabled = inTauri()

  async function call(command, args) {
    return tauriInvoke(command, args)
  }

  async function listFiles(displayCodes) {
    return filesToImports(await call('texts_list'), { displayCodes })
  }

  async function read(id) {
    const file = await call('texts_read', { id: String(id) })
    const row = fileToImport(file)
    if (!row) throw new Error('Could not read that text.')
    return row
  }

  async function write(record) {
    if (!enabled) throw new Error('Could not save this text.')
    await call('texts_write', { text: toTextDraft(record) })
  }

  async function remove(id) {
    if (!enabled) return
    await call('texts_delete', { id: String(id) })
  }

  async function migrate() {
    if (!enabled) return { done: true, verified: [] }
    const raw = loadJSON(IMPORTS_KEY)
    const records = loadImports()
    if (!records.length) return { done: true, verified: [] }
    const existing = await listFiles(false)
    const planned = assignMigrationCodes(records, existing)
    const result = await migrateStoredImports({
      records: planned,
      async readText(id) {
        try {
          return await read(id)
        } catch {
          return null
        }
      },
      writeText: (record) => write(record),
    })
    if (!result.verified.length) return result
    const next = importsAfterMigration(raw, result.verified)
    if (next.removeKey) {
      if (!clearImports()) return { ...result, done: false }
    } else if (next.list) {
      const saved = writeImports(next.list)
      if (!saved.ok) return { ...result, done: false }
    }
    return result
  }

  function watch(handler) {
    if (!enabled || typeof handler !== 'function') return
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('texts://changed', () => handler()))
      .catch(() => {})
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => handler())
    }
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          if (focused) handler()
        }),
      )
      .catch(() => {})
  }

  return {
    enabled,
    list() {
      if (!enabled) return Promise.resolve(loadImports())
      return listFiles(true)
    },
    read,
    write,
    remove,
    migrate,
    watch,
  }
}
