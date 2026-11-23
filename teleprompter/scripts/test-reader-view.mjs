import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReaderView, renderScriptHtml } from '../src/reading/reader-view.js'

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

test('the reader opens the mic with the sheet and does not render voice enhance', () => {
  const sheet = { innerHTML: '' }
  const previous = globalThis.document
  globalThis.document = {
    querySelector(selector) {
      return selector === '.sheet' ? sheet : null
    },
    querySelectorAll() {
      return []
    },
  }
  const opened = []
  const recording = {
    isRecWithRun: () => true,
    renderTakes: () => Promise.resolve(),
    renderMicSelects() {},
    resetRulerTrack() {},
    syncRecUi() {},
    restoreRecorderPanel() {},
    bindWavePointer() {},
    recorderPanelHtml: () => '<div id="recorder-panel"></div>',
    onRecWithRunChange() {},
    onMicChange() {},
    noteReaderOpen(open) {
      opened.push(open)
    },
  }
  const view = createReaderView({
    escapeHtml: (value) => value,
    current: () => null,
    folderState: () => ({}),
    stageEmptyMessage: () => 'No text',
    isRunning: () => false,
    getSpeed: () => 20,
    getFontSize: () => 32,
    getOffset: () => 0,
    getLineNodes: () => [],
    getLineMetrics: () => [],
    getOffsetCache: () => ({ max: 0 }),
    scriptFocusY: () => 0,
    pixelsPerSecond: () => 1,
    clearMetrics() {},
    measure() {},
    observeView() {},
    disconnectView() {},
    restoreIfNeeded() {},
    applyOffset() {},
    startLoop() {},
    toggleRun() {},
    setSpeed() {},
    applyFontSize() {},
    scrollBy() {},
    toTop() {},
    toggleFullscreen() {},
    recording,
  })
  try {
    view.renderSheet()
    assert.deepEqual(opened, [false])
    assert.match(sheet.innerHTML, /No text/)

    recording.current = null
    view.renderSheet()
    const withEssay = createReaderView({
      escapeHtml: (value) => value,
      current: () => ({ code: 'E01', words: 4, minutes: 1, title: 'Hello', body: 'One line' }),
      folderState: () => ({}),
      stageEmptyMessage: () => 'No text',
      isRunning: () => false,
      getSpeed: () => 20,
      getFontSize: () => 32,
      getOffset: () => 0,
      getLineNodes: () => [],
      getLineMetrics: () => [],
      getOffsetCache: () => ({ max: 0 }),
      scriptFocusY: () => 0,
      pixelsPerSecond: () => 1,
      clearMetrics() {},
      measure() {},
      observeView() {},
      disconnectView() {},
      restoreIfNeeded() {},
      applyOffset() {},
      startLoop() {},
      toggleRun() {},
      setSpeed() {},
      applyFontSize() {},
      scrollBy() {},
      toTop() {},
      toggleFullscreen() {},
      recording,
    })
    withEssay.renderSheet()
    assert.deepEqual(opened, [false, false, true])
    assert.match(sheet.innerHTML, /id="mic-idle"/)
    assert.match(sheet.innerHTML, /id="rec"/)
    assert.equal(sheet.innerHTML.includes('Voice enhance'), false)
    assert.equal(sheet.innerHTML.includes('voice-enhance'), false)
    assert.equal(typeof recording.voiceEnhanceControl, 'undefined')
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})
