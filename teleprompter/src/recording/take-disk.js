import { documentDir, join } from '@tauri-apps/api/path'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { BaseDirectory, exists, mkdir, remove, writeFile } from '@tauri-apps/plugin-fs'
import { inTauri } from '../library/essay-folder.js'
import { takeFileName } from './recording.js'
import { sidecarBytes, suffixedTakeName } from './takes-catalog.js'

const DIR = 'Teleprompter'
const base = { baseDir: BaseDirectory.Document }

function splitName(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

function sidecarName(audioName) {
  const { stem } = splitName(audioName)
  return `${stem || audioName}.json`
}

function canonical(path) {
  return String(path).replace(/[\\/]+/g, '/').replace(/\/+$/, '')
}

function isDirectChild(root, filePath) {
  const rootPath = canonical(root)
  const file = canonical(filePath)
  const prefix = `${rootPath}/`
  const windows = String(root).includes('\\') || String(filePath).includes('\\')
  const prefixCmp = windows ? prefix.toLowerCase() : prefix
  const fileCmp = windows ? file.toLowerCase() : file
  if (!fileCmp.startsWith(prefixCmp)) return false
  const name = file.slice(prefix.length)
  return name.length > 0 && !name.includes('/') && name !== '.' && name !== '..'
}

async function documentsTakeDir() {
  return join(await documentDir(), DIR)
}

async function absoluteTakePath(fileName) {
  return join(await documentsTakeDir(), fileName)
}

// The page remuxes an mp4/AAC take before this runs, in the browser and in
// the Tauri webview, so the Documents file is the same progressive M4A.
// The sidecar is the text key, duration, time, peaks, and mime for that file.
export async function saveTakeToDocuments(take) {
  if (!inTauri() || !take?.blob?.size) return null
  const name = takeFileName(take)
  await mkdir(DIR, { ...base, recursive: true })
  const bytes = new Uint8Array(await take.blob.arrayBuffer())

  let written = ''
  for (let n = 1; n < 1000; n += 1) {
    const candidate = suffixedTakeName(name, n)
    const path = `${DIR}/${candidate}`
    if (await exists(path, base)) continue
    try {
      await writeFile(path, bytes, { ...base, createNew: true })
      written = candidate
      break
    } catch (error) {
      // The plugin serializes Rust I/O errors as strings.
      if (!/\(os error (17|80|183)\)$/.test(String(error))) throw error
    }
  }
  if (!written) throw new Error('Could not save the take to Documents.')
  try {
    await writeTakeSidecar(written, take)
  } catch (error) {
    await remove(`${DIR}/${written}`, base).catch(() => {})
    throw error
  }
  let path = ''
  try {
    path = await absoluteTakePath(written)
  } catch {
    path = ''
  }
  return { name: written, path }
}

export async function writeTakeSidecar(audioName, take) {
  if (!inTauri()) throw new Error('Could not save the take to Documents.')
  const fileName = fileNameOnly(audioName)
  if (!fileName) throw new Error('Could not save the take to Documents.')
  await mkdir(DIR, { ...base, recursive: true })
  await writeFile(`${DIR}/${sidecarName(fileName)}`, sidecarBytes(take, take?.peaks), base)
}

function fileNameOnly(name) {
  const file = String(name || '').split(/[\\/]/).pop() || ''
  if (!file || file === '.' || file === '..' || file.startsWith('.')) return ''
  return file
}

export async function revealTakeFile(diskPath) {
  if (!inTauri()) return
  const root = await documentsTakeDir()
  if (!isDirectChild(root, diskPath)) throw new Error('Could not show that file.')
  await revealItemInDir(diskPath)
}
