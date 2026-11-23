/**
 * Essays folder chosen by the reader.
 * Inside the Tauri window this uses the native folder dialog and the fs plugin.
 * In a browser it keeps the File System Access directory handle.
 */
import { open } from '@tauri-apps/plugin-dialog'
import { readDir, readTextFile, remove } from '@tauri-apps/plugin-fs'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

const DB_NAME = 'teleprompter-folder'
const DB_VERSION = 1
const STORE = 'folder'
const KEY = 'essays'
const PATH_KEY = 'teleprompter:essay-folder'

let database = null
let dbPromise = null

export function inTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
}

export function folderPickerSupported() {
  return inTauri() || (typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function')
}

export function isTxtName(name) {
  const file = String(name).split(/[/\\]/).pop() ?? ''
  return file.length > 4 && file.toLowerCase().endsWith('.txt')
}

export function folderBaseName(path) {
  const parts = String(path).split(/[/\\]/).filter(Boolean)
  return parts.pop() || 'Folder'
}

function joinPath(dir, name) {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

function isScopeError(error) {
  const message = String(error?.message || error).toLowerCase()
  return message.includes('forbidden') || message.includes('not allowed')
}

export function isFolderScopeError(error) {
  return isScopeError(error)
}

function safeTxtName(name) {
  return typeof name === 'string' && !/[\\/]/.test(name) && name !== '.' && name !== '..' && isTxtName(name)
}

export async function deleteEssayFile(folder, fileName) {
  if (!safeTxtName(fileName)) throw new Error('Could not delete that essay.')
  if (folder?.path) {
    await remove(joinPath(folder.path, fileName))
    return
  }
  if (!folder?.requestPermission || typeof folder.removeEntry !== 'function') {
    throw new Error('Could not delete that essay.')
  }
  const status = await folder.requestPermission({ mode: 'readwrite' })
  if (status !== 'granted') throw new Error('Could not delete that essay.')
  await folder.removeEntry(fileName)
}

export async function revealEssayFile(folder, fileName) {
  if (!folder?.path || !safeTxtName(fileName)) throw new Error('Could not show that file.')
  await revealItemInDir(joinPath(folder.path, fileName))
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

function loadSavedPath() {
  try {
    const path = localStorage.getItem(PATH_KEY)
    if (!path) return null
    return { path, name: folderBaseName(path) }
  } catch {
    return null
  }
}

function savePath(path) {
  localStorage.setItem(PATH_KEY, path)
}

function clearPath() {
  try {
    localStorage.removeItem(PATH_KEY)
  } catch {
    /* ignore quota or private mode */
  }
}

export async function loadSavedFolder() {
  if (inTauri()) return loadSavedPath()
  const db = await openDb()
  const handle = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY)
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => reject(request.error || new Error('Could not read the saved folder'))
  })
  return isDirectoryHandle(handle) ? handle : null
}

export async function saveFolderHandle(folder) {
  if (folder?.path) {
    savePath(folder.path)
    return
  }
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(folder, KEY)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error('Could not remember this folder'))
  })
}

export async function clearSavedFolder() {
  clearPath()
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error || new Error('Could not forget this folder'))
    })
  } catch {
    if (!inTauri()) throw new Error('Could not forget this folder')
  }
}

export async function folderPermission(folder) {
  if (folder?.path) {
    try {
      await readDir(folder.path)
      return 'granted'
    } catch (error) {
      if (isScopeError(error)) return 'prompt'
      return 'missing'
    }
  }
  if (!folder?.queryPermission) return 'denied'
  try {
    return await folder.queryPermission({ mode: 'read' })
  } catch {
    return 'denied'
  }
}

export async function requestFolderPermission(folder) {
  if (folder?.path) return folderPermission(folder)
  if (!folder?.requestPermission) return 'denied'
  try {
    return await folder.requestPermission({ mode: 'read' })
  } catch {
    return 'denied'
  }
}

export async function pickEssayFolder(defaultPath) {
  if (inTauri()) {
    const picked = await open({
      directory: true,
      multiple: false,
      recursive: true,
      title: 'Essays',
      defaultPath: defaultPath || undefined,
    })
    if (picked == null) {
      const error = new Error('cancelled')
      error.name = 'AbortError'
      throw error
    }
    const path = typeof picked === 'string' ? picked : ''
    if (!path) throw new Error('Could not open that folder.')
    return { path, name: folderBaseName(path) }
  }
  return window.showDirectoryPicker({ id: 'teleprompter-essays', mode: 'read' })
}

export async function readEssayFiles(folder) {
  if (folder?.path) {
    const entries = await readDir(folder.path)
    const items = []
    for (const entry of entries) {
      if (!entry || entry.isDirectory || !isTxtName(entry.name)) continue
      const text = await readTextFile(joinPath(folder.path, entry.name))
      items.push({ file: entry.name, text })
    }
    items.sort((a, b) => a.file.localeCompare(b.file))
    return items
  }
  const items = []
  for await (const [name, entry] of folder.entries()) {
    if (!entry || entry.kind !== 'file' || !isTxtName(name)) continue
    const file = await entry.getFile()
    items.push({ file: name, text: await file.text() })
  }
  items.sort((a, b) => a.file.localeCompare(b.file))
  return items
}
