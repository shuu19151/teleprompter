import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filesFromTransfer, importDialogMarkup, isFileDrag } from '../src/library/import-dialog.js'
import { confirmDialogMarkup } from '../src/shell/confirm-dialog.js'

test('file drags are recognized only when the transfer lists Files', () => {
  assert.equal(isFileDrag({}), false)
  assert.equal(isFileDrag({ dataTransfer: null }), false)
  assert.equal(isFileDrag({ dataTransfer: { types: ['text/plain'] } }), false)
  assert.equal(isFileDrag({ dataTransfer: { types: ['text/plain', 'Files'] } }), true)
})

test('dropped files prefer the file list, then file items', () => {
  const fromList = { name: 'a.txt' }
  assert.deepEqual(filesFromTransfer({ files: [fromList], items: [{ kind: 'file', getAsFile: () => ({ name: 'b.txt' }) }] }), [fromList])
  const fromItem = { name: 'b.md' }
  assert.deepEqual(
    filesFromTransfer({
      files: [],
      items: [
        { kind: 'string', getAsFile: () => ({ name: 'nope' }) },
        { kind: 'file', getAsFile: () => fromItem },
        { kind: 'file', getAsFile: () => null },
      ],
    }),
    [fromItem],
  )
  assert.deepEqual(filesFromTransfer(null), [])
  assert.deepEqual(filesFromTransfer({}), [])
})

test('import and confirm dialogs keep their ids, labels, and actions', () => {
  const importDialog = importDialogMarkup()
  assert.match(importDialog, /id="import-dialog" aria-labelledby="import-heading"/)
  assert.match(importDialog, /id="import-heading">Import text</)
  assert.match(importDialog, /id="import-name"/)
  assert.match(importDialog, /id="import-body"/)
  assert.match(importDialog, /id="import-file"/)
  assert.match(importDialog, /id="import-file-button"[^>]+aria-label="Choose a text file"/)
  assert.match(importDialog, /id="import-file-name" aria-live="polite">No file chosen</)
  assert.match(importDialog, /id="import-error"/)
  assert.match(importDialog, /id="import-cancel"/)
  assert.ok(importDialog.includes('id="import-save" type="submit">Import</button>'))

  const confirm = confirmDialogMarkup()
  assert.ok(confirm.includes('id="confirm-dialog" aria-labelledby="confirm-heading" aria-describedby="confirm-copy"'))
  assert.ok(confirm.includes('id="confirm-heading">Delete take?</h2>'))
  assert.ok(confirm.includes('id="confirm-copy"'))
  assert.ok(confirm.includes('id="confirm-cancel" type="button">Cancel</button>'))
  assert.ok(confirm.includes('id="confirm-delete" type="button">Delete</button>'))
})
