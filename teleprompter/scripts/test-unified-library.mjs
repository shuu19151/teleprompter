import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLibrary } from '../src/library/library-controller.js'
import { migrateLibrary } from '../src/library/library-migration.js'
import { sameTextContent } from '../src/library/text-duplicates.js'
import { takeTextKey } from '../src/recording/recorder-math.js'

function fixture(initial = []) {
  let rows = structuredClone(initial)
  let writes = 0
  const notices = []
  const store = {
    folder: { name: 'Library' },
    boot: async () => {}, migrate: async () => {}, watch: () => {}, allow: async () => {},
    list: async () => structuredClone(rows),
    read: async id => { const row = rows.find(row => row.id === id); if (!row) throw Error('Missing'); return structuredClone(row) },
    write: async row => { writes++; rows = [...rows.filter(item => item.id !== row.id), structuredClone(row)] },
    remove: async id => { rows = rows.filter(row => row.id !== id) },
    choose: async () => { store.folder = { name: 'Other' }; rows = [] },
  }
  const deps = new Proxy({
    askConfirm: async () => true, capturedReadingPlace: () => ({ index: 0, fraction: 0 }),
    showNotice: text => notices.push(text), setLoadError: text => notices.push(text), isEditing: () => false,
  }, { get: (obj, key) => obj[key] || (() => {}) })
  const library = createLibrary({ bundledEssays: [], texts: store, deps, loadJSON: () => null })
  return { library, store, deps, notices, get writes() { return writes }, get rows() { return rows } }
}
const original = { id: 'import-one', code: 'U1', title: 'Notes', body: 'Body', createdAt: 1, extension: 'txt' }

test('imports skip identical normalized title/body and preserve different content', async () => {
  const f = fixture([original]); await f.library.bootTexts()
  const same = await f.library.addImport('Notes\r\n\r\nBody\r\n')
  assert.equal(same.item.id, original.id); assert.equal(f.writes, 0)
  const different = await f.library.addImport('Notes\n\nAnother body')
  assert.notEqual(different.item.id, original.id); assert.equal(f.rows.length, 2)
})
test('edit detects external changes and missing files without overwriting them', async () => {
  const f = fixture([original]); await f.library.bootTexts()
  await f.store.write({ ...original, body: 'Changed externally' })
  assert.match((await f.library.updateImport(original.id, 'Notes', 'My edit')).error, /outside the app/)
  assert.equal(f.rows[0].body, 'Changed externally')
  await f.store.remove(original.id)
  assert.match((await f.library.updateImport(original.id, 'Notes', 'My edit')).error, /Missing/)
  assert.equal(f.rows.length, 0)
})
test('folder changes clear selection and do not copy the previous library', async () => {
  const f = fixture([original]); await f.library.bootTexts(); f.library.restoreEssay()
  assert.equal(f.library.current().id, original.id)
  await f.library.chooseFolder()
  assert.equal(f.library.current(), undefined); assert.equal(f.rows.length, 0); assert.equal(f.writes, 0)
})
test('refresh is deferred while editing and updates after the dialog closes', async () => {
  const f = fixture([original]); await f.library.bootTexts(); f.library.restoreEssay()
  f.deps.isEditing = () => true
  await f.store.write({ ...original, body: 'External' })
  await f.library.reloadEssays(); assert.equal(f.library.current().body, 'Body')
  f.deps.isEditing = () => false
  await f.library.reloadEssays(); assert.equal(f.library.current().body, 'External')
})
test('migration resumes verified copies, retains sources, and does not resurrect deleted texts', async () => {
  const f = fixture()
  const records = [original, { ...original, id: 'import-two', title: 'Other' }]
  const map = new Map(); const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }
  const write = f.store.write
  f.store.write = async row => { if (row.id === 'import-two') throw Error('Disk full'); return write(row) }
  await assert.rejects(migrateLibrary({ store: f.store, records, storage }), /Disk full/)
  assert.equal(f.rows.length, 1)
  await f.store.remove(original.id)
  f.store.write = write
  await migrateLibrary({ store: f.store, records, storage })
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].id, 'import-two')
  await f.store.remove('import-two')
  await migrateLibrary({ store: f.store, records, storage })
  assert.equal(f.rows.length, 0); assert.equal(records[0].body, 'Body')
})
test('migration refuses ID collisions and does not mark failed verification as complete', async () => {
  const f = fixture([{ ...original, body: 'Different' }])
  const storage = { getItem: () => null, setItem: () => assert.fail('Must not checkpoint') }
  await assert.rejects(migrateLibrary({ store: f.store, records: [original], storage }), /same ID/)
  assert.equal(f.writes, 0)
})
test('migrated essay recordings retain their old key even after title changes', () => {
  assert.equal(takeTextKey({ kind: 'import', id: 'E01-original.txt', code: 'E01', title: 'Renamed' }), 'E01')
  assert.equal(takeTextKey({ kind: 'import', id: 'import-one', code: 'U1' }), 'import-one')
  assert.equal(sameTextContent(original, { ...original, body: ' Body\r\n' }), true)
})
