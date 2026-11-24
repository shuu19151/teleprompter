import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assignMigrationCodes,
  filesToImports,
  importsAfterMigration,
  migrateStoredImports,
  nextImportCode,
  sameImport,
  textExtension,
  toTextDraft,
  withDisplayCodes,
} from '../src/library/texts-catalog.js'

const market = {
  id: 'import-9',
  title: 'Market Notes',
  body: 'Apples\n\nLine',
  createdAt: '2026-11-23T04:50:00.000Z',
}

const second = {
  id: 'import-10',
  title: 'Second',
  body: 'Keep',
  createdAt: 1_700_000_000_000,
  updatedAt: '2026-11-23T05:10:00.000Z',
}

test('a folder row keeps the id, and a dropped file keeps its generated id', () => {
  const rows = filesToImports([
    {
      id: 'import-9',
      code: 'U1',
      title: 'Market Notes',
      body: 'Apples\n\nLine',
      createdAt: market.createdAt,
      extension: 'md',
      name: 'U1-market-notes.md',
      sidecar: true,
    },
    {
      id: 'file-0123456789abcdef',
      code: '',
      title: 'Daily Log',
      body: 'hello',
      createdAt: 20,
      extension: 'txt',
      name: 'daily-log.txt',
      sidecar: false,
    },
    { id: 'import-9', title: 'duplicate', body: 'no' },
    { id: '', title: 'skip', body: 'no' },
    null,
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, 'import-9')
  assert.equal(rows[0].code, 'U1')
  assert.equal(rows[0].body, 'Apples\n\nLine')
  assert.equal(rows[0].extension, 'md')
  assert.equal(rows[1].id, 'file-0123456789abcdef')
  assert.equal(rows[1].title, 'Daily Log')
  assert.equal(rows[1].code, 'U2')
  assert.equal(rows[1].extension, 'txt')
  assert.deepEqual(filesToImports(null), [])
})

test('display codes fill gaps without colliding with a stored code', () => {
  const coded = withDisplayCodes([
    { id: 'a', code: '', title: 'A' },
    { id: 'b', code: 'U1', title: 'B' },
    { id: 'c', code: '', title: 'C' },
  ])
  assert.deepEqual(
    coded.map((item) => item.code),
    ['U2', 'U1', 'U3'],
  )
  assert.equal(nextImportCode(coded), 'U4')
  assert.equal(nextImportCode([]), 'U1')
})

test('migration keeps the original id and only clears entries that read back', async () => {
  const disk = new Map()
  let writes = 0
  const records = assignMigrationCodes([market, second], [])
  assert.deepEqual(
    records.map((record) => record.code),
    ['U1', 'U2'],
  )
  assert.equal(records[0].id, 'import-9')
  assert.equal(records[0].extension, 'md')

  const run = () =>
    migrateStoredImports({
      records,
      async readText(id) {
        return disk.get(id) ?? null
      },
      async writeText(record) {
        writes += 1
        assert.ok(record.id === 'import-9' || record.id === 'import-10')
        disk.set(record.id, {
          id: record.id,
          title: record.title,
          body: record.body,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          code: record.code,
        })
      },
    })

  const first = await run()
  assert.equal(writes, 2)
  assert.deepEqual(first.verified, ['import-9', 'import-10'])
  assert.equal(first.done, true)
  assert.equal(disk.get('import-9').body, 'Apples\n\nLine')
  assert.equal(disk.get('import-9').createdAt, market.createdAt)
  assert.equal(disk.get('import-10').createdAt, second.createdAt)
  assert.equal(disk.get('import-10').updatedAt, second.updatedAt)

  const secondRun = await run()
  assert.equal(writes, 2)
  assert.deepEqual(secondRun.verified, ['import-9', 'import-10'])
  assert.equal(toTextDraft(disk.get('import-9')).id, 'import-9')
  assert.equal('updatedAt' in toTextDraft(disk.get('import-9')), false)
  assert.equal(toTextDraft(disk.get('import-10')).updatedAt, second.updatedAt)
})

test('a failed read-back stays in browser storage and a match does not', async () => {
  const raw = [market, second, { nope: true }, { id: 4, title: 'no' }]
  let writes = 0
  const result = await migrateStoredImports({
    records: [market, second],
    async readText(id) {
      if (id === 'import-9') return { ...market, body: 'different' }
      return null
    },
    async writeText(record) {
      writes += 1
      if (record.id === 'import-10') throw new Error('disk full')
    },
  })
  assert.equal(writes, 2)
  assert.deepEqual(result.verified, [])
  assert.equal(result.done, false)
  const kept = importsAfterMigration(raw, result.verified)
  assert.equal(kept.removeKey, false)
  assert.equal(kept.list.length, 4)

  const done = await migrateStoredImports({
    records: [market],
    async readText() {
      return { ...market }
    },
    async writeText() {
      throw new Error('should not write')
    },
  })
  assert.deepEqual(done.verified, ['import-9'])
  const rest = importsAfterMigration(raw, done.verified)
  assert.equal(rest.removeKey, false)
  assert.deepEqual(
    rest.list.map((item) => (typeof item.id === 'string' ? item.id : 'malformed')),
    ['import-10', 'malformed', 'malformed'],
  )
  assert.equal(importsAfterMigration([market], ['import-9']).removeKey, true)
  assert.deepEqual(importsAfterMigration({ id: 'import-9' }, ['import-9']), { list: null, removeKey: false })
})

test('migration codes skip codes already stored on disk', () => {
  const planned = assignMigrationCodes([market, second], [{ code: 'U1' }, { code: '' }])
  assert.deepEqual(
    planned.map((record) => [record.id, record.code]),
    [
      ['import-9', 'U2'],
      ['import-10', 'U3'],
    ],
  )
  assert.equal(textExtension({ fileName: 'notes.TXT' }), 'txt')
  assert.equal(textExtension({ fileName: 'notes.md' }), 'md')
  assert.equal(textExtension({ fileName: '', existing: 'txt' }), 'txt')
  assert.equal(textExtension({}), 'md')
  assert.equal(sameImport({ ...market, code: 'U9' }, market), true)
  assert.equal(sameImport({ ...market, body: 'Apples\r\n\r\nLine' }, market), false)
  assert.equal(sameImport({ ...market, createdAt: 1 }, market), false)
  assert.equal(sameImport({ ...second, updatedAt: null }, second), false)
})
