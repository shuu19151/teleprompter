/**
 * One catalog for takes. In the Tauri window it is Documents/Teleprompter.
 * On the Vite page the same methods keep an in-memory list and mirror each
 * blob into IndexedDB, which is what the Playwright smoke test reads.
 */
import { inTauri } from '../library/essay-folder.js'
import { readStorage, writeStorage } from '../shared/storage.js'
import { addTake, listAllTakes, removeTake, warmRecordingStore } from './recording.js'
import { saveTakeToDocuments, writeTakeSidecar } from './take-disk.js'
import {
  MIGRATION_FLAG,
  createMemoryTakes,
  filesToTakes,
  finishMigration,
  migrateTakes,
} from './takes-catalog.js'

function bytesToBlob(bytes, mime) {
  if (bytes instanceof Blob) return bytes
  if (bytes instanceof ArrayBuffer) return new Blob([bytes], { type: mime })
  if (ArrayBuffer.isView(bytes)) return new Blob([bytes], { type: mime })
  if (Array.isArray(bytes)) return new Blob([new Uint8Array(bytes)], { type: mime })
  throw new Error('Could not read that take.')
}

async function tauriInvoke(command, args) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

async function migrateDocumentsTakes() {
  await finishMigration({
    isDone: () => readStorage(MIGRATION_FLAG) === '1',
    markDone: () => writeStorage(MIGRATION_FLAG, '1'),
    run: async () => {
      const records = await listAllTakes()
      const files = filesToTakes(await tauriInvoke('takes_list'))
      return migrateTakes({
        records,
        files,
        async writeTake(record) {
          const saved = await saveTakeToDocuments(record)
          if (!saved?.name) return null
          const listed = filesToTakes(await tauriInvoke('takes_list'))
          const found = listed.find((file) => file.name === saved.name)
          return { name: saved.name, bytes: found?.bytes || 0 }
        },
        writeSidecar(record, file) {
          return writeTakeSidecar(file.name, record)
        },
        removeBlob(id) {
          return removeTake(id)
        },
      })
    },
  })
}

export function createTakesStore() {
  const tauri = inTauri()
  const memory = createMemoryTakes()
  let started = false

  return {
    async start() {
      if (started) return
      started = true
      if (tauri) {
        try {
          await migrateDocumentsTakes()
        } catch (error) {
          console.error('Could not migrate takes to Documents.', error)
        }
        return
      }
      await warmRecordingStore()
      try {
        memory.replace(await listAllTakes())
      } catch {
        /* the page list stays empty until a take is saved */
      }
    },
    async list() {
      if (!tauri) return memory.list()
      return filesToTakes(await tauriInvoke('takes_list'))
    },
    async save(take) {
      if (tauri) {
        const saved = await saveTakeToDocuments(take)
        if (!saved?.name) throw new Error('Could not save the take to Documents.')
        return {
          ...take,
          id: saved.name,
          name: saved.name,
          diskPath: saved.path || '',
        }
      }
      const stored = await addTake(take)
      return memory.save(stored)
    },
    async remove(id) {
      if (tauri) {
        await tauriInvoke('takes_delete', { name: String(id) })
        return
      }
      const numeric = Number(id)
      if (Number.isInteger(numeric)) await removeTake(numeric)
      memory.remove(id)
    },
    async readBlob(take) {
      if (take?.blob instanceof Blob) return take.blob
      if (!tauri) {
        const found = memory.list().find((row) => String(row.id) === String(take?.id))
        if (found?.blob instanceof Blob) return found.blob
        throw new Error('Could not read that take.')
      }
      const name = take?.name || take?.id
      const bytes = await tauriInvoke('takes_read', { name: String(name) })
      return bytesToBlob(bytes, take?.mimeType || 'audio/mp4')
    },
  }
}
