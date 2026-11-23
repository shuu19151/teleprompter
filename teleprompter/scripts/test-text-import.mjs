import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EMPTY_IMPORT_MESSAGE,
  MAX_IMPORT_BYTES,
  SIZE_IMPORT_MESSAGE,
  fallbackTitle,
  keptImportBody,
  newImportRecord,
  parseImportedText,
  readingPlaceAfterEdit,
  resolvedImportTitle,
  scriptLineCount,
  textBytes,
  updatedImportRecord,
  validateImportBody,
} from '../src/library/import-store.js'

const limit = 'a'.repeat(MAX_IMPORT_BYTES)
const over = `${limit}b`

test('import size is measured in bytes and rejects text over 200 KB', () => {
  assert.equal(MAX_IMPORT_BYTES, 200 * 1024)
  assert.equal(textBytes(''), 0)
  assert.equal(textBytes('é'), 2)
  assert.equal(textBytes(limit), MAX_IMPORT_BYTES)
  assert.equal(textBytes(over), MAX_IMPORT_BYTES + 1)
  assert.deepEqual(validateImportBody(limit), { text: limit })
  assert.deepEqual(validateImportBody(over), { error: SIZE_IMPORT_MESSAGE })
  assert.deepEqual(validateImportBody(`é${'a'.repeat(MAX_IMPORT_BYTES - 1)}`), { error: SIZE_IMPORT_MESSAGE })
  assert.deepEqual(parseImportedText(over), { error: SIZE_IMPORT_MESSAGE })
  assert.deepEqual(parseImportedText(over, { markdown: true }), { error: SIZE_IMPORT_MESSAGE })
})

test('empty, missing, and whitespace-only text is rejected', () => {
  for (const raw of ['', '   ', '\n\n', '\uFEFF', '\r\n\r\n', null, undefined, 0, {}]) {
    assert.deepEqual(validateImportBody(raw), { error: EMPTY_IMPORT_MESSAGE })
    assert.deepEqual(parseImportedText(raw), { error: EMPTY_IMPORT_MESSAGE })
  }
  assert.deepEqual(validateImportBody('# \n\n##\t', { markdown: true }), { error: EMPTY_IMPORT_MESSAGE })
})

test('validation normalizes newlines and strips markdown headings only when asked', () => {
  assert.deepEqual(validateImportBody('\uFEFF# Hello\r\n\r\nBody\r'), { text: '# Hello\n\nBody' })
  assert.deepEqual(validateImportBody('# Hello\n\nBody', { markdown: true }), { text: 'Hello\n\nBody' })
  assert.deepEqual(validateImportBody('# Hello\n\nBody', { fileName: 'notes.md' }), { text: 'Hello\n\nBody' })
  assert.deepEqual(validateImportBody('# Hello\n\nBody', { fileName: 'notes.txt', markdown: false }), {
    text: '# Hello\n\nBody',
  })
  assert.deepEqual(validateImportBody('##Hello\n\nstill', { markdown: true }), { text: '##Hello\n\nstill' })
  assert.deepEqual(validateImportBody('####### seven\n\nbody', { markdown: true }), { text: '####### seven\n\nbody' })
  assert.equal(validateImportBody('  padded  ').text, 'padded')
})

test('parseImportedText splits a title block, a typed title, a file name, and a first line', () => {
  assert.deepEqual(parseImportedText('Market notes\n\nApples were expensive.'), {
    title: 'Market Notes',
    body: 'Apples were expensive.',
  })
  assert.deepEqual(parseImportedText('how the day goes\n\nBody'), {
    title: 'How the Day Goes',
    body: 'Body',
  })
  assert.deepEqual(parseImportedText('Heading\n\nBody', { title: '  Custom  ' }), {
    title: 'Custom',
    body: 'Body',
  })
  assert.deepEqual(parseImportedText('Just one line', { title: 'Custom' }), {
    title: 'Custom',
    body: 'Just one line',
  })
  assert.deepEqual(parseImportedText('Just one line', { fileName: 'market-notes.txt' }), {
    title: 'Market Notes',
    body: 'Just one line',
  })
  assert.deepEqual(parseImportedText('first line\nsecond stays'), {
    title: 'First Line',
    body: 'second stays',
  })
  assert.deepEqual(parseImportedText('only line'), {
    title: 'Only Line',
    body: 'only line',
  })
  assert.deepEqual(parseImportedText('# Market notes\r\n\r\nApples', { fileName: 'notes.md' }), {
    title: 'Market Notes',
    body: 'Apples',
  })
  assert.deepEqual(parseImportedText('   ', { fileName: '.md' }), { error: EMPTY_IMPORT_MESSAGE })
  const long = `${'Word '.repeat(50).trim()}\n\nBody`
  const parsed = parseImportedText(long)
  assert.equal(parsed.title.endsWith('…'), true)
  assert.equal(parsed.title.length <= 180, true)
  assert.equal(parsed.body, 'Body')
})

test('fallback title uses the block, the file name, the first line, then Untitled', () => {
  assert.equal(fallbackTitle('market notes\n\nApples', ''), 'Market Notes')
  assert.equal(fallbackTitle('one line of script', 'market_notes.md'), 'Market Notes')
  assert.equal(fallbackTitle('how the day goes', ''), 'How the Day Goes')
  assert.equal(fallbackTitle('', ''), 'Untitled')
  assert.equal(fallbackTitle('   \n\n   ', '   '), 'Untitled')
  assert.equal(fallbackTitle('', 'notes.txt'), 'Notes')
  const huge = 'Word '.repeat(80)
  assert.equal(fallbackTitle(huge, '').endsWith('…'), true)
  assert.equal(resolvedImportTitle('  Kept title  ', 'ignored\n\nbody', 'file.txt'), 'Kept title')
  assert.equal(resolvedImportTitle('   ', 'market notes\n\nbody', ''), 'Market Notes')
  assert.equal(resolvedImportTitle('', 'only', 'daily-log.txt'), 'Daily Log')
})

test('an unchanged body is kept, including when normalization would rewrite it', () => {
  const stored = 'Hello  \n\nThere'
  assert.equal(keptImportBody(stored, stored, 'Hello\n\nThere'), stored)
  assert.equal(keptImportBody(stored, 'Hello\r\n\r\nThere', stored), stored)
  assert.equal(keptImportBody('Hello', 'Hello\n\nWorld', 'Hello\n\nWorld'), 'Hello\n\nWorld')
  assert.equal(keptImportBody('Hello', 'Hello ', 'Hello'), 'Hello')
})

test('editing keeps the line, clamps it when the script shrinks, and resets when no lines remain', () => {
  assert.equal(scriptLineCount(null), 0)
  assert.equal(scriptLineCount(''), 0)
  assert.equal(scriptLineCount(' \n\n\t'), 0)
  assert.equal(scriptLineCount('a\n\nb\n \nc'), 3)
  assert.deepEqual(readingPlaceAfterEdit({ bodyChanged: false, body: '', index: 40, fraction: 0.2 }), {
    index: 40,
    fraction: 0.2,
  })
  assert.equal(readingPlaceAfterEdit({ bodyChanged: true, body: '\n\n', index: 3, fraction: 0.5 }), null)
  assert.equal(readingPlaceAfterEdit({ bodyChanged: true, body: '   ', index: 0, fraction: 1 }), null)
  assert.deepEqual(readingPlaceAfterEdit({ bodyChanged: true, body: 'a\n\nb', index: 9, fraction: 1.5 }), {
    index: 1,
    fraction: 1.5,
  })
  assert.deepEqual(readingPlaceAfterEdit({ bodyChanged: true, body: 'only', index: 0, fraction: 0 }), {
    index: 0,
    fraction: 0,
  })
  assert.deepEqual(readingPlaceAfterEdit({ bodyChanged: true, body: 'a\nb\nc', index: -2, fraction: 0.1 }), {
    index: -2,
    fraction: 0.1,
  })
})

test('a new import has no updated time, and an edit keeps id and createdAt', () => {
  const created = newImportRecord({
    id: 'imp-1',
    title: 'Market notes',
    body: 'Apples',
    createdAt: '2026-11-23T04:50:00.000Z',
  })
  assert.deepEqual(created, {
    id: 'imp-1',
    title: 'Market notes',
    body: 'Apples',
    createdAt: '2026-11-23T04:50:00.000Z',
  })
  assert.equal('updatedAt' in created, false)

  const existing = { id: 'imp-1', title: 'Old', body: 'Old body', createdAt: 1700000000000, extra: 'no' }
  assert.deepEqual(
    updatedImportRecord(existing, { title: 'New', body: 'New body', updatedAt: '2026-11-23T05:10:00.000Z' }),
    {
      id: 'imp-1',
      title: 'New',
      body: 'New body',
      createdAt: 1700000000000,
      updatedAt: '2026-11-23T05:10:00.000Z',
    },
  )
})
