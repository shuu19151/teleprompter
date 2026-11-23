import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeAttr, escapeHtml } from '../src/shared/html.js'

test('HTML and attribute text escape the same characters', () => {
  const raw = `a < b & "c" > d`
  const escaped = 'a &lt; b &amp; &quot;c&quot; &gt; d'
  assert.equal(escapeHtml(raw), escaped)
  assert.equal(escapeAttr(raw), escaped)
})
