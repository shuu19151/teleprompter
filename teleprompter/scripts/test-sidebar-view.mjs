import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  essayListEmptyMessage,
  folderGestureMessage,
  importListEmptyMessage,
  sidebarMarkup,
  stageEmptyMessage,
} from '../src/library/sidebar-view.js'

const folder = { path: 'C:\\Essays', name: 'Essays' }
const handleOnly = { name: 'Essays' }

test('essay list empty copy follows search, permission, and folder', () => {
  assert.equal(essayListEmptyMessage({ query: ' calm ', folderNeedsGesture: true, folderHandle: folder }), 'No essay matches.')
  assert.equal(essayListEmptyMessage({ query: '   ', folderNeedsGesture: true, folderHandle: folder }), 'Allow this folder to show its essays.')
  assert.equal(essayListEmptyMessage({ query: '', folderNeedsGesture: false, folderHandle: folder }), 'No .txt files in this folder.')
  assert.equal(essayListEmptyMessage({ query: '', folderNeedsGesture: false, folderHandle: null }), 'No essay matches.')
})

test('stage empty copy stays distinct from the essay list', () => {
  assert.equal(stageEmptyMessage({ folderNeedsGesture: true, folderHandle: null }), 'Allow access to your library folder.')
  assert.equal(stageEmptyMessage({ folderNeedsGesture: false, folderHandle: folder }), 'No texts in this folder. Import a .txt or .md file to begin.')
  assert.equal(
    stageEmptyMessage({ folderNeedsGesture: false, folderHandle: null }),
    'Choose a library folder to get started.',
  )
})

test('import list empty copy depends on the search box', () => {
  assert.equal(importListEmptyMessage(''), 'Nothing imported yet.')
  assert.equal(importListEmptyMessage('  notes '), 'No text matches.')
})

test('folder permission prompt names Folder or reload', () => {
  assert.equal(folderGestureMessage({ folderHandle: folder, folderName: 'Essays' }), 'Click Folder to allow reading Essays.')
  assert.equal(folderGestureMessage({ folderHandle: handleOnly, folderName: 'Essays' }), 'Click reload to allow reading Essays.')
  assert.equal(folderGestureMessage({ folderHandle: null, folderName: '' }), 'Click reload to allow reading this folder.')
})

test('sidebar has one Texts list and a separate Takes list', () => {
  const hidden = sidebarMarkup({ dev: false, folderHandle: null, folderName: '' })
  assert.match(hidden, /id="reload" type="button" aria-label="Refresh texts" disabled>/)
  assert.match(hidden, /id="folder-name" class="folder-name" hidden>/)
  assert.doesNotMatch(hidden, /use-app-essays|essay-list|My texts/)
  assert.match(hidden, />Texts<\/p>/)
  assert.match(hidden, /id="import-list" aria-labelledby="imports-label"/)
  assert.match(hidden, /id="takes-list" aria-labelledby="takes-label"/)
  assert.match(hidden, /id="choose-folder"/)
  assert.match(hidden, /id="import-open"/)

  const dev = sidebarMarkup({ dev: true, folderHandle: null, folderName: '' })
  assert.match(dev, /aria-label="Refresh texts" disabled>/)
  const chosen = sidebarMarkup({ dev: false, folderHandle: { name: 'Essays' }, folderName: 'Essays' })
  assert.match(chosen, /aria-label="Refresh texts" >/)
  assert.match(chosen, /id="folder-name" class="folder-name" >/)
  assert.doesNotMatch(chosen, /use-app-essays/)
})
