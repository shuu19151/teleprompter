import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  asImportEssay,
  currentReading,
  essayIndexByFile,
  essayStorageRecord,
  filterEssays,
  filterImports,
  itemKey,
  openTextKey,
  positionApplies,
  positionStorageRecord,
  resolveSelection,
} from '../src/library/content-selection.js'

const essays = [
  { kind: 'essay', file: 'E01-how-i-stay-productive-and-calm.txt', code: 'E01', title: 'How I Stay Productive and Calm at Work' },
  { kind: 'essay', file: 'E02-how-i-give-and-receive-feedback.txt', code: 'E02', title: 'How I Give and Receive Feedback at Work' },
  { file: 'notes.txt', code: 'notes.txt', title: 'Loose Notes' },
]

const imports = [
  { id: 'imp-1', title: 'Market notes', body: 'Apples were expensive today.', createdAt: '2026-11-23T04:50:00.000Z' },
  { id: 'imp-2', title: 'Second', body: 'More apples.', createdAt: 1700000000000 },
]

test('itemKey uses the import id and the essay filename', () => {
  assert.equal(itemKey(null), '')
  assert.equal(itemKey(undefined), '')
  assert.equal(itemKey(essays[0]), essays[0].file)
  assert.equal(itemKey(essays[2]), 'notes.txt')
  assert.equal(itemKey({ kind: 'import', id: 'imp-1', file: 'other' }), 'imp-1')
  assert.equal(itemKey({ kind: 'import' }), undefined)
})

test('essay storage record matches the saved essay and import shapes', () => {
  assert.deepEqual(essayStorageRecord(essays[0]), {
    file: 'E01-how-i-stay-productive-and-calm.txt',
    code: 'E01',
    kind: 'essay',
    id: 'E01-how-i-stay-productive-and-calm.txt',
  })
  assert.deepEqual(essayStorageRecord(essays[2]), {
    file: 'notes.txt',
    code: 'notes.txt',
    kind: 'essay',
    id: 'notes.txt',
  })
  const reading = asImportEssay(imports[0], 0)
  assert.deepEqual(essayStorageRecord(reading), {
    file: 'imp-1',
    code: 'U1',
    kind: 'import',
    id: 'imp-1',
  })
  assert.equal(essayStorageRecord(null), null)
})

test('position storage record keeps the line form or the offset form', () => {
  assert.deepEqual(
    positionStorageRecord({ index: 4, fraction: 0.18, offset: 120, id: essays[0].file, useLine: true }),
    { index: 4, fraction: 0.18, id: essays[0].file },
  )
  assert.deepEqual(positionStorageRecord({ index: 4, fraction: 0.18, offset: 0, id: 'imp-1' }), {
    offset: 0,
    id: 'imp-1',
  })
  assert.deepEqual(positionStorageRecord({ offset: -20, id: '' }), { offset: -20, id: '' })
})

test('position applies for a matching id, a missing id, and a legacy non-string id', () => {
  const key = essays[0].file
  assert.equal(positionApplies(null, key), false)
  assert.equal(positionApplies([], key), true)
  assert.equal(positionApplies({ offset: 10 }, key), true)
  assert.equal(positionApplies({ id: key, offset: 10 }, key), true)
  assert.equal(positionApplies({ id: 'other', offset: 10 }, key), false)
  assert.equal(positionApplies({ id: '', offset: 10 }, ''), true)
  assert.equal(positionApplies({ id: 12, offset: 10 }, key), true)
  assert.equal(positionApplies('E01', key), false)
})

test('resolveSelection restores an essay by file, then by code', () => {
  assert.equal(resolveSelection({ savedSelection: null, essays, imports }), null)
  assert.equal(resolveSelection({ savedSelection: undefined, essays, imports }), null)
  assert.equal(resolveSelection({ savedSelection: 'E01', essays, imports }), null)
  assert.equal(resolveSelection({ savedSelection: 0, essays, imports }), null)
  assert.deepEqual(resolveSelection({ savedSelection: { file: essays[1].file, code: 'E01' }, essays, imports }), {
    kind: 'essay',
    index: 1,
  })
  assert.deepEqual(resolveSelection({ savedSelection: { code: 'E02' }, essays, imports }), { kind: 'essay', index: 1 })
  assert.deepEqual(
    resolveSelection({ savedSelection: { file: 'missing.txt', code: 'notes.txt' }, essays, imports }),
    { kind: 'essay', index: 2 },
  )
  assert.equal(
    resolveSelection({ savedSelection: { file: 'gone.txt', code: 'E99', kind: 'essay' }, essays, imports }),
    null,
  )
  assert.equal(resolveSelection({ savedSelection: { file: essays[0].file }, essays: [], imports }), null)
})

test('resolveSelection opens a saved import and falls back when it was deleted', () => {
  assert.deepEqual(
    resolveSelection({
      savedSelection: { file: 'imp-2', code: 'U2', kind: 'import', id: 'imp-2' },
      essays,
      imports,
    }),
    { kind: 'import', importId: 'imp-2' },
  )
  assert.deepEqual(
    resolveSelection({
      savedSelection: { kind: 'import', file: 'imp-1' },
      essays,
      imports,
    }),
    { kind: 'import', importId: 'imp-1' },
  )
  assert.deepEqual(
    resolveSelection({
      savedSelection: { kind: 'import', id: 'deleted', file: essays[1].file, code: 'E02' },
      essays,
      imports,
    }),
    { kind: 'essay', index: 0, importId: null },
  )
  assert.deepEqual(
    resolveSelection({
      savedSelection: { kind: 'import', id: 'deleted' },
      essays: [],
      imports: [],
    }),
    { kind: 'essay', index: 0, importId: null },
  )
  assert.deepEqual(
    resolveSelection({
      savedSelection: { kind: 'import', id: 15, file: 'imp-1' },
      essays,
      imports,
    }),
    { kind: 'import', importId: 'imp-1' },
  )
  assert.deepEqual(
    resolveSelection({
      savedSelection: { kind: 'import' },
      essays,
      imports,
    }),
    { kind: 'essay', index: 0, importId: null },
  )
})

test('current reading prefers a live import and otherwise the essay index', () => {
  const reading = currentReading({ kind: 'import', index: 1, importId: 'imp-2', essays, imports })
  assert.equal(reading.code, 'U2')
  assert.equal(reading.file, 'imp-2')
  assert.equal(reading.kind, 'import')
  assert.equal(currentReading({ kind: 'import', index: 0, importId: 'deleted', essays, imports }), essays[0])
  assert.equal(currentReading({ kind: 'essay', index: 2, importId: 'imp-1', essays, imports }), essays[2])
  assert.equal(currentReading({ kind: 'essay', index: 9, importId: null, essays, imports }), undefined)
  assert.equal(currentReading({ kind: 'essay', index: 0, importId: null, essays: [], imports: [] }), undefined)
})

test('import reading counts words and keeps at least one minute', () => {
  const empty = asImportEssay({ id: 'e', title: '', body: '', createdAt: 't' }, 3)
  assert.equal(empty.code, 'U4')
  assert.equal(empty.words, 0)
  assert.equal(empty.minutes, 1)
  assert.equal(empty.file, 'e')
  const counted = asImportEssay({ id: 'e', title: 'One two', body: 'three', createdAt: 1 }, 0)
  assert.equal(counted.words, 3)
  assert.equal(counted.minutes, 1)
})

test('open text key and essay file lookup', () => {
  assert.equal(openTextKey({ kind: 'import', index: 1, importId: 'imp-1', essays }), 'imp-1')
  assert.equal(openTextKey({ kind: 'essay', index: 1, essays }), essays[1].file)
  assert.equal(openTextKey({ kind: 'essay', index: 8, essays }), undefined)
  assert.equal(openTextKey({ kind: 'essay', essays: [] }), undefined)
  assert.equal(essayIndexByFile(essays, essays[2].file), 2)
  assert.equal(essayIndexByFile(essays, 'missing.txt'), -1)
  assert.equal(essayIndexByFile([], essays[0].file), -1)
})

test('filters essays by code and title and imports by code, title, and script', () => {
  assert.deepEqual(
    filterEssays(essays, '  ').map(({ index }) => index),
    [0, 1, 2],
  )
  assert.deepEqual(
    filterEssays(essays, 'e02').map(({ index }) => index),
    [1],
  )
  assert.deepEqual(
    filterEssays(essays, 'FEEDBACK').map(({ essay }) => essay.code),
    ['E02'],
  )
  assert.deepEqual(filterEssays(essays, 'apples'), [])
  assert.deepEqual(filterEssays([], 'e01'), [])
  assert.deepEqual(filterEssays(essays, 'e0.').map(({ index }) => index), [])

  const all = filterImports(imports, '')
  assert.deepEqual(
    all.map(({ reading }) => reading.code),
    ['U1', 'U2'],
  )
  assert.equal(filterImports(imports, 'u2')[0].item.id, 'imp-2')
  assert.equal(filterImports(imports, 'APPLES')[0].index, 0)
  assert.equal(filterImports(imports, 'more apples')[0].reading.code, 'U2')
  assert.deepEqual(filterImports(imports, 'nope'), [])
  assert.deepEqual(filterImports([], 'notes'), [])
})
