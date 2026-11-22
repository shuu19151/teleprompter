import { documentDir, join } from '@tauri-apps/api/path'
import { BaseDirectory, exists, mkdir, writeFile } from '@tauri-apps/plugin-fs'
import { inTauri } from './essay-folder.js'
import { takeFileName } from './recording.js'

const DIR = 'Teleprompter'
const base = { baseDir: BaseDirectory.Document }

function splitName(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

async function documentsTakeDir() {
  return join(await documentDir(), DIR)
}

async function absoluteTakePath(fileName) {
  return join(await documentsTakeDir(), fileName)
}

export async function saveTakeToDocuments(take) {
  if (!inTauri() || !take?.blob?.size) return
  const name = takeFileName(take)
  const { stem, ext } = splitName(name)
  await mkdir(DIR, { ...base, recursive: true })
  const bytes = new Uint8Array(await take.blob.arrayBuffer())

  let written = name
  for (let n = 1; ; n += 1) {
    written = n === 1 ? name : `${stem}-${n}${ext}`
    const path = `${DIR}/${written}`
    if (await exists(path, base)) continue
    try {
      await writeFile(path, bytes, { ...base, createNew: true })
      break
    } catch (error) {
      // The plugin serializes Rust I/O errors as strings.
      if (!/\(os error (17|80|183)\)$/.test(String(error))) throw error
    }
  }
  try {
    return await absoluteTakePath(written)
  } catch {
    return undefined
  }
}
