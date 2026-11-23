import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseTakes } from '../src/recording/recorder-math.js'
import {
  MIGRATION_FLAG,
  createMemoryTakes,
  downsamplePeaks,
  filesToTakes,
  finishMigration,
  matchTakeFile,
  migrateTakes,
  sidecarDocument,
  suffixedTakeName,
} from '../src/recording/takes-catalog.js'

const essay = { kind: 'essay', code: 'E01', title: 'How I Stay Productive' }
const imported = { kind: 'import', id: 'imp-1', code: 'U1', title: 'Market notes' }

test('folder rows group by text key, newest first', () => {
  const rows = filesToTakes([
    { name: 'old.m4a', textKey: 'E01', createdAt: 10, durationMs: 1000, mime: 'audio/mp4', path: '/docs/old.m4a', bytes: 20, peaks: [0.1] },
    { name: 'other.m4a', textKey: 'imp-1', createdAt: 50, durationMs: 500, mime: 'audio/mp4', path: '/docs/other.m4a', bytes: 8 },
    { name: 'new.m4a', textKey: 'E01', createdAt: 30, durationMs: 2000, mime: 'audio/mp4', path: '/docs/new.m4a', bytes: 40, sidecar: true },
    { name: '', textKey: 'E01', createdAt: 90 },
    null,
  ])
  assert.deepEqual(
    chooseTakes(rows, essay).map((take) => take.id),
    ['new.m4a', 'old.m4a'],
  )
  assert.deepEqual(
    chooseTakes(rows, imported).map((take) => take.id),
    ['other.m4a'],
  )
  assert.equal(rows.find((take) => take.id === 'new.m4a').diskPath, '/docs/new.m4a')
  assert.equal(rows.find((take) => take.id === 'new.m4a').sidecar, true)
  assert.deepEqual(filesToTakes(null), [])
})

test('a catalog change notifies listeners with the rows left behind', () => {
  const catalog = createMemoryTakes()
  const seen = []
  const stop = catalog.subscribe((rows) => {
    seen.push(rows.map((row) => row.id))
  })
  catalog.save({ id: 'a.m4a', textKey: 'E01', createdAt: 2, durationMs: 1000, blob: { size: 4 } })
  catalog.save({ id: 'b.m4a', textKey: 'E01', createdAt: 1, durationMs: 500, blob: { size: 4 } })
  catalog.save({ id: 'a.m4a', textKey: 'E01', createdAt: 4, durationMs: 1500, blob: { size: 8 } })
  catalog.remove('missing.m4a')
  catalog.remove('a.m4a')
  stop()
  catalog.save({ id: 'c.m4a', textKey: 'E02', createdAt: 9, durationMs: 10 })
  assert.deepEqual(seen, [['a.m4a'], ['a.m4a', 'b.m4a'], ['a.m4a', 'b.m4a'], ['b.m4a']])
  assert.deepEqual(
    chooseTakes(catalog.list(), essay).map((take) => take.id),
    ['b.m4a'],
  )
  assert.equal(catalog.list().find((take) => take.id === 'b.m4a').blob.size, 4)
  assert.throws(() => catalog.save({ textKey: 'E01' }), /no id/)
})

test('replacing the catalog is the rescan after a folder change', () => {
  const catalog = createMemoryTakes()
  const seen = []
  catalog.subscribe((rows) => seen.push(rows.map((row) => `${row.id}:${row.textKey}`)))
  catalog.replace([
    { id: 'E01-one.m4a', name: 'E01-one.m4a', textKey: 'E01', createdAt: 1 },
    { id: 'E01-two.m4a', name: 'E01-two.m4a', textKey: 'E01', createdAt: 2 },
  ])
  catalog.replace([{ id: 'E01-two.m4a', name: 'E01-two.m4a', textKey: 'E01', createdAt: 2 }])
  assert.deepEqual(seen, [['E01-one.m4a:E01', 'E01-two.m4a:E01'], ['E01-two.m4a:E01']])
  assert.deepEqual(
    chooseTakes(catalog.list(), essay).map((take) => take.id),
    ['E01-two.m4a'],
  )
})

test('sidecar document keeps the text key and a short waveform', () => {
  const peaks = []
  for (let i = 0; i < 1000; i += 1) peaks.push(i === 10 ? 2 : i / 1000)
  const document = sidecarDocument(
    { textKey: 'imp-1', durationMs: 1500.4, createdAt: 20, mimeType: 'audio/mp4' },
    peaks,
  )
  assert.equal(document.version, 1)
  assert.equal(document.textKey, 'imp-1')
  assert.equal(document.durationMs, 1500)
  assert.equal(document.createdAt, 20)
  assert.equal(document.mime, 'audio/mp4')
  assert.equal(document.peaks.length, 400)
  assert.ok(document.peaks.some((peak) => peak === 1))
  assert.deepEqual(downsamplePeaks(null), [])
  assert.deepEqual(downsamplePeaks([0.2, -0.4]), [0.2, 0.4])
  assert.equal(suffixedTakeName('E01-title-20261122-1804.m4a', 1), 'E01-title-20261122-1804.m4a')
  assert.equal(suffixedTakeName('E01-title-20261122-1804.m4a', 2), 'E01-title-20261122-1804-2.m4a')
  assert.equal(MIGRATION_FLAG, 'teleprompter:takesMigrated')
})

test('migration writes a missing file, then deletes the blob only after the file is non-empty', async () => {
  const record = {
    id: 7,
    textKey: 'E01',
    createdAt: 10,
    durationMs: 1000,
    mimeType: 'audio/mp4',
    blob: { size: 12 },
  }
  const removed = []
  let writes = 0

  const empty = await migrateTakes({
    records: [record],
    files: [],
    writeTake: async () => {
      writes += 1
      return { name: 'E01-title.m4a', bytes: 0 }
    },
    writeSidecar: async () => {
      throw new Error('sidecar should wait for audio')
    },
    removeBlob: async (id) => removed.push(id),
  })
  assert.equal(empty.done, false)
  assert.equal(writes, 1)
  assert.deepEqual(removed, [])

  const failed = await migrateTakes({
    records: [record],
    files: [],
    writeTake: async () => {
      writes += 1
      throw new Error('disk')
    },
    writeSidecar: async () => {},
    removeBlob: async (id) => removed.push(id),
  })
  assert.equal(failed.done, false)
  assert.equal(writes, 2)
  assert.deepEqual(removed, [])

  const written = await migrateTakes({
    records: [record],
    files: [],
    writeTake: async () => ({ name: 'E01-title.m4a', bytes: 12 }),
    writeSidecar: async () => {
      throw new Error('audio write already stored the sidecar')
    },
    removeBlob: async (id) => removed.push(id),
  })
  assert.equal(written.done, true)
  assert.deepEqual(removed, [7])
})

test('migration is idempotent and a second take in the same minute is still written', async () => {
  const first = { id: 1, textKey: 'E01', createdAt: 10, blob: { size: 4 }, diskPath: 'C:\\Users\\a\\Documents\\Teleprompter\\E01-a.m4a' }
  const second = { id: 2, textKey: 'E01', createdAt: 11, blob: { size: 4 } }
  const files = [{ name: 'E01-a.m4a', bytes: 4, sidecar: true, textKey: 'E01', createdAt: 10 }]
  let writes = 0
  const removed = []
  const sidecars = []

  const again = await migrateTakes({
    records: [first],
    files,
    writeTake: async () => {
      writes += 1
      return { name: 'should-not.m4a', bytes: 4 }
    },
    writeSidecar: async (_record, file) => sidecars.push(file.name),
    removeBlob: async (id) => removed.push(id),
  })
  assert.equal(again.done, true)
  assert.equal(writes, 0)
  assert.deepEqual(sidecars, [])
  assert.deepEqual(removed, [1])

  const both = await migrateTakes({
    records: [first, second],
    files,
    writeTake: async (record) => {
      writes += 1
      assert.equal(record.id, 2)
      return { name: 'E01-a-2.m4a', bytes: 4 }
    },
    writeSidecar: async () => {
      throw new Error('the new file writes its own sidecar')
    },
    removeBlob: async (id) => removed.push(id),
  })
  assert.equal(both.done, true)
  assert.equal(writes, 1)
  assert.deepEqual(removed, [1, 1, 2])
})

test('an existing audio file gets a sidecar before its blob is removed', async () => {
  const record = {
    id: 3,
    textKey: 'imp-1',
    createdAt: 5,
    blob: { size: 9 },
    diskPath: '/home/a/Documents/Teleprompter/U1-notes.m4a',
  }
  const sidecars = []
  const removed = []
  const result = await migrateTakes({
    records: [record, { id: 4 }, { id: 5, blob: { size: 0 } }],
    files: [{ name: 'U1-notes.m4a', bytes: 9, sidecar: false, textKey: '', createdAt: 0 }],
    writeTake: async () => {
      throw new Error('audio is already in Documents')
    },
    writeSidecar: async (row, file) => {
      sidecars.push([file.name, row.textKey])
    },
    removeBlob: async (id) => removed.push(id),
  })
  assert.equal(result.done, true)
  assert.deepEqual(sidecars, [['U1-notes.m4a', 'imp-1']])
  assert.deepEqual(removed, [3])
  assert.equal(matchTakeFile(record, [{ name: 'U1-notes.m4a', bytes: 0 }]), null)
})

test('a failed sidecar write keeps the blob and leaves the migration unfinished', async () => {
  const removed = []
  const result = await migrateTakes({
    records: [{ id: 8, textKey: 'E01', createdAt: 1, blob: { size: 3 }, diskPath: '/docs/Teleprompter/E01-a.m4a' }],
    files: [{ name: 'E01-a.m4a', bytes: 3, sidecar: false }],
    writeTake: async () => ({ name: 'nope.m4a', bytes: 3 }),
    writeSidecar: async () => {
      throw new Error('json')
    },
    removeBlob: async (id) => removed.push(id),
  })
  assert.equal(result.done, false)
  assert.deepEqual(removed, [])
})

test('the migration flag is set only after a finished run', async () => {
  let marked = false
  const interrupted = await finishMigration({
    isDone: () => marked,
    markDone: () => {
      marked = true
    },
    run: async () => ({ done: false }),
  })
  assert.deepEqual(interrupted, { skipped: false, done: false })
  assert.equal(marked, false)

  const finished = await finishMigration({
    isDone: () => marked,
    markDone: () => {
      marked = true
    },
    run: async () => ({ done: true }),
  })
  assert.deepEqual(finished, { skipped: false, done: true })
  assert.equal(marked, true)

  let ran = false
  const skipped = await finishMigration({
    isDone: () => marked,
    markDone: () => {
      marked = false
    },
    run: async () => {
      ran = true
      return { done: true }
    },
  })
  assert.equal(ran, false)
  assert.deepEqual(skipped, { skipped: true, done: true })
  assert.equal(marked, true)
})
