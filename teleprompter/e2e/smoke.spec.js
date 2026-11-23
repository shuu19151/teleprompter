import { expect, test } from '@playwright/test'

const E01_TITLE = 'How I Stay Productive and Calm at Work'
const E02_TITLE = 'How I Give and Receive Feedback at Work'

async function activeLineIndex(page) {
  return page.locator('#text-script .line').evaluateAll((lines) =>
    lines.findIndex((line) => line.classList.contains('is-active')),
  )
}

test('opens the default essay, runs, and reloads at the paused line', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(E01_TITLE)
  await expect(page.locator('#text-script')).toContainText('When people ask me what my job')
  await expect(page.locator('#essay-list .essay.is-on .code')).toHaveText('E01')
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible()

  await page.locator('#speed').fill('50')
  await expect(page.locator('#speed-value')).toHaveText('50')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  const pause = page.getByRole('button', { name: 'Pause', exact: true })
  await expect(pause).toHaveAttribute('aria-pressed', 'true')

  await expect.poll(() => activeLineIndex(page)).toBeGreaterThan(2)
  await pause.click()
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveAttribute('aria-pressed', 'false')

  const pausedLine = await activeLineIndex(page)
  const pausedText = (await page.locator('#text-script .line.is-active').innerText()).trim()
  expect(pausedLine).toBeGreaterThan(2)
  expect(Number(await page.locator('#progress-bar').getAttribute('aria-valuenow'))).toBeGreaterThan(0)
  await expect.poll(() => activeLineIndex(page)).toBe(pausedLine)

  await page.reload()
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(E01_TITLE)
  await expect(page.locator('#essay-list .essay.is-on .code')).toHaveText('E01')
  await expect.poll(() => activeLineIndex(page)).toBe(pausedLine)
  await expect(page.locator('#text-script .line.is-active')).toHaveText(pausedText)
})

test('selects another essay, returns to the first, and reloads that selection', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(E01_TITLE)

  await page.locator('#speed').fill('50')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect.poll(() => activeLineIndex(page)).toBeGreaterThan(2)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  const pausedLine = await activeLineIndex(page)
  expect(pausedLine).toBeGreaterThan(2)

  await page.locator('#essay-list .essay', { hasText: 'E02' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(E02_TITLE)
  await expect(page.locator('#essay-list .essay.is-on .code')).toHaveText('E02')
  await expect(page.locator('#text-script')).toContainText('When people ask me about the hardest')

  // One position slot: choosing E02 replaces it, so E01 opens at the top.
  await page.locator('#essay-list .essay', { hasText: 'E01' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(E01_TITLE)
  await expect(page.locator('#essay-list .essay.is-on .code')).toHaveText('E01')
  await expect(page.locator('#text-script')).toContainText('When people ask me what my job')
  await expect.poll(() => activeLineIndex(page)).toBe(0)

  await page.reload()
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(E01_TITLE)
  await expect(page.locator('#essay-list .essay.is-on .code')).toHaveText('E01')
  await expect.poll(() => activeLineIndex(page)).toBe(0)
})

test('imports a text and shows it', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import text' })
  await expect(dialog).toBeVisible()
  await dialog.locator('#import-file').setInputFiles({
    name: 'market-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Apples were expensive.\n\nI bought three and walked home.\n'),
  })
  await expect(dialog.locator('#import-body')).toHaveValue(/I bought three and walked home/)
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(dialog).toBeHidden()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Apples Were Expensive.')
  await expect(page.locator('#text-script')).toContainText('I bought three and walked home.')
  await expect(page.locator('#import-list .essay.is-on')).toContainText('Apples Were Expensive.')
  await expect(page.locator('#import-list .essay.is-on .code')).toHaveText('U1')
})

test('theme and font size persist after reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
  const theme = page.locator('#theme')
  await expect(theme).toHaveText('Dark')
  await theme.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(theme).toHaveText('Light')

  await page.locator('#font-size').fill('44')
  await expect(page.locator('#font-size-value')).toHaveText('44')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--script-size').trim())).toBe('44px')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('#theme')).toHaveText('Light')
  await expect(page.locator('#font-size')).toHaveValue('44')
  await expect(page.locator('#font-size-value')).toHaveText('44')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--script-size').trim())).toBe('44px')
})

test('a short recording creates a take', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#takes-list')).toContainText('No takes yet')

  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.locator('#rec')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#recorder-panel')).toHaveAttribute('data-mode', 'recording')
  await expect.poll(async () => (await page.locator('#recorder-clock').innerText()).trim()).not.toBe('00:00.00')

  await page.locator('#recorder-panel').getByRole('button', { name: 'Stop recording' }).click()
  await expect(page.locator('#takes-list .take-row')).toHaveCount(1)
  await expect(page.locator('#takes-list .take-select')).toBeVisible()
  await expect(page.locator('#takes-list')).not.toContainText('No takes yet')
})
