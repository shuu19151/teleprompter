import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderScriptHtml } from '../src/reading/reader-view.js'

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

test('script html keeps blank lines as gaps and escapes text', () => {
  assert.equal(
    renderScriptHtml('Hello\n\nWorld', (value) => value),
    '<p class="line">Hello</p><div class="gap"></div><p class="line">World</p>',
  )
  assert.equal(renderScriptHtml('  \n\t', (value) => value), '<div class="gap"></div><div class="gap"></div>')
  assert.equal(renderScriptHtml('', (value) => value), '<div class="gap"></div>')
  assert.equal(
    renderScriptHtml('a < b & "c"', escapeHtml),
    '<p class="line">a &lt; b &amp; &quot;c&quot;</p>',
  )
})
