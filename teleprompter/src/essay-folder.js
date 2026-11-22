/**
 * A user-picked essays folder, remembered as a directory handle.
 * Separate from the `teleprompter` takes database so this store never
 * bumps that schema.
 */
const DB_NAME = 'teleprompter-folder'
const DB_VERSION = 1
const STORE = 'folder'
const KEY = 'essays'

let database = null
let dbPromise = null

export function folderPickerSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

export function isTxtName(name) {
  const file = String(name).split(/[/\\]/).pop() ?? ''
  return file.length > 4 && file.toLowerCase().endsWith('.txt')
}

function openDb() {
  if (database) return Promise.resolve(database)
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available'))
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => {
      database = request.result
      database.onversionchange = () => {
        database.close()
        database = null
        dbPromise = null
      }
      resolve(database)
    }
    request.onerror = () => {
      dbPromise = null
      reject(request.error || new Error('Could not open folder storage'))
    }
  })
  return dbPromise
}

function isDirectoryHandle(value) {
  return !!value && typeof value.queryPermission === 'function' && typeof value.entries === 'function'
}

export async function loadSavedFolder() {
  const db = await openDb()
  const handle = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY)
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => reject(request.error || new Error('Could not read the saved folder'))
  })
  return isDirectoryHandle(handle) ? handle : null
}

export async function saveFolderHandle(handle) {
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(handle, KEY)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('Could not remember this folder'))
  })
}

export async function clearSavedFolder() {
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('Could not forget this folder'))
  })
}

export async function folderPermission(handle) {
  if (!handle?.queryPermission) return 'denied'
  try {
    return await handle.queryPermission({ mode: 'read' })
  } catch {
    return 'denied'
  }
}

export async function requestFolderPermission(handle) {
  if (!handle?.requestPermission) return 'denied'
  try {
    return await handle.requestPermission({ mode: 'read' })
  } catch {
    return 'denied'
  }
}

export async function pickEssayFolder() {
  const handle = await window.showDirectoryPicker({ id: 'teleprompter-essays', mode: 'read' })
  return handle
}

export async function readEssayFiles(handle) {
  const items = []
  for await (const [name, entry] of handle.entries()) {
    if (!entry || entry.kind !== 'file' || !isTxtName(name)) continue
    const file = await entry.getFile()
    items.push({ file: name, text: await file.text() })
  }
  items.sort((a, b) => a.file.localeCompare(b.file))
  return items
}
