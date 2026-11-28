import { sameTextContent } from './text-duplicates.js'

const KEY = 'teleprompter:library-migration-v1'

// Checkpoint only verified copies; retain the originals as a backup.
export async function migrateLibrary({ store, records, storage }) {
  const saved = JSON.parse(storage.getItem(KEY) || '{"verified":[]}')
  if (saved.complete) return
  const verified = new Set(saved.verified || [])
  const existing = await store.list()
  for (const record of records) {
    if (verified.has(record.id)) continue
    let found = existing.find(item => item.id === record.id)
    if (found && !record.bundled && !sameTextContent(found, record)) {
      throw new Error(`Could not migrate "${record.title}": a different text has the same ID.`)
    }
    if (!found) {
      await store.write(record)
      found = await store.read(record.id)
      if (!found || found.id !== record.id || !sameTextContent(found, record)) {
        throw new Error(`Could not verify the migrated text "${record.title}".`)
      }
    }
    verified.add(record.id)
    storage.setItem(KEY, JSON.stringify({ verified: [...verified] }))
  }
  storage.setItem(KEY, JSON.stringify({ complete: true, verified: [...verified] }))
}
