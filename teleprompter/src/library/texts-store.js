import { inTauri, loadSavedFolder, saveFolderHandle, pickEssayFolder, folderBaseName, folderPickerSupported } from './essay-folder.js'
import { loadImports } from './import-store.js'
import { filesToImports, fileToImport, toTextDraft, assignMigrationCodes } from './texts-catalog.js'
import { createBrowserTexts } from './browser-texts.js'
import { migrateLibrary } from './library-migration.js'

async function invoke(command, args) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

export function isAndroidTauri() {
  return inTauri() && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
}

export function createTextsStore() {
  const native = inTauri()
  const android = isAndroidTauri()
  let folder = null
  const browser = createBrowserTexts(() => folder)
  const store = {
    get folder() { return folder },
    async boot() {
      if (android) {
        const info = await invoke('plugin:android-documents|getSavedDirectory')
        folder = info?.uri ? { uri: info.uri, name: info.name || 'App Library', internal: !!info.internal } : null
      } else if (native) {
        const path = await invoke('texts_folder')
        folder = path ? { path, name: folderBaseName(path) } : null
      } else {
        folder = await loadSavedFolder()
      }
    },
    async choose() {
      if (android) {
        try {
          const picked = await invoke('plugin:android-documents|pickDirectory')
          folder = { uri: picked.uri, name: picked.name || 'Folder', internal: !!picked.internal }
          return
        } catch (error) {
          if (String(error?.message || error).toLowerCase().includes('cancelled')) {
            const abort = new Error('cancelled')
            abort.name = 'AbortError'
            throw abort
          }
          throw error
        }
      }
      if (!folderPickerSupported()) throw new Error('Use the desktop app or Chrome/Edge to choose a library folder.')
      const previous = folder || await loadSavedFolder().catch(() => null)
      const picked = await pickEssayFolder(previous?.path)
      if (native) await invoke('texts_set_folder', { path: picked.path })
      else await saveFolderHandle(picked)
      folder = picked
    },
    async allow() {
      if (!native && folder?.requestPermission) {
        if (await folder.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Allow access to this folder first.')
      }
    },
    async list() {
      if (!folder) return []
      if (android) {
        const res = await invoke('plugin:android-documents|listTexts')
        return filesToImports(res?.items || [])
      }
      return native ? filesToImports(await invoke('texts_list')) : browser.list()
    },
    async read(id) {
      if (android) return fileToImport(await invoke('plugin:android-documents|readText', { id }))
      return native ? fileToImport(await invoke('texts_read', { id })) : browser.read(id)
    },
    async write(record) {
      // Android plugin manages its own internal folder — skip the null-folder guard
      if (android) return fileToImport(await invoke('plugin:android-documents|writeText', { text: toTextDraft(record) }))
      if (!folder) throw new Error('Choose a library folder first.')
      return native ? fileToImport(await invoke('texts_write', { text: toTextDraft(record) })) : browser.write(record)
    },
    async remove(id) {
      if (android) {
        await invoke('plugin:android-documents|deleteText', { id })
        return
      }
      if (!folder) throw new Error('Choose a library folder first.')
      if (native) await invoke('texts_delete', { id })
      else await browser.remove(id)
    },
    async migrate(bundledEssays) {
      if (!folder) return
      if (JSON.parse(localStorage.getItem('teleprompter:library-migration-v1') || '{}').complete) return
      const legacy = native && !android ? filesToImports(await invoke('texts_legacy_list')) : []
      const bundled = bundledEssays.map(item => ({ ...item, id: item.file, extension: 'txt', createdAt: 0, bundled: true }))
      const records = [...new Map([...bundled, ...loadImports(), ...legacy].map(item => [item.id, item])).values()]
      await migrateLibrary({ store, records: assignMigrationCodes(records, await store.list()), storage: localStorage })
    },
    watch(handler) {
      if (typeof window !== 'undefined') window.addEventListener('focus', handler)
      if (native && !android) {
        import('@tauri-apps/api/event').then(({ listen }) => listen('texts://changed', handler)).catch(() => {})
      }
    },
  }
  return store
}
