import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ENTER_ICON, EXIT_ICON, fullscreenControl } from '../src/shell/fullscreen.js'

test('fullscreen button state matches the enter and exit icons', () => {
  assert.deepEqual(fullscreenControl(false), {
    pressed: 'false',
    label: 'Enter fullscreen',
    icon: ENTER_ICON,
  })
  assert.deepEqual(fullscreenControl(true), {
    pressed: 'true',
    label: 'Exit fullscreen',
    icon: EXIT_ICON,
  })
  assert.match(ENTER_ICON, /M8 4H4v4/)
  assert.match(EXIT_ICON, /M9 4v5H4/)
})
