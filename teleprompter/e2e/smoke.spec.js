import { expect, test } from '@playwright/test'
import { prepareLibrary } from './library-fixture.js'

test.beforeEach(async ({ page }) => { await prepareLibrary(page) })

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
  await expect(page.locator('#import-list .essay.is-on .code')).toHaveText('E01')
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
  await expect(page.locator('#import-list .essay.is-on .code')).toHaveText('E01')
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

  await page.locator('#import-list .essay', { hasText: 'E02' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(E02_TITLE)
  await expect(page.locator('#import-list .essay.is-on .code')).toHaveText('E02')
  await expect(page.locator('#text-script')).toContainText('When people ask me about the hardest')

  // One position slot: choosing E02 replaces it, so E01 opens at the top.
  await page.locator('#import-list .essay', { hasText: 'E01' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(E01_TITLE)
  await expect(page.locator('#import-list .essay.is-on .code')).toHaveText('E01')
  await expect(page.locator('#text-script')).toContainText('When people ask me what my job')
  await expect.poll(() => activeLineIndex(page)).toBe(0)

  await page.reload()
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(E01_TITLE)
  await expect(page.locator('#import-list .essay.is-on .code')).toHaveText('E01')
  await expect.poll(() => activeLineIndex(page)).toBe(0)
})

test('import dialog preserves drafts until canceled or submitted', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import text' })
  const body = dialog.locator('#import-body')
  await body.fill('Draft text')
  await expect(body).toHaveCSS('resize', 'none')

  await page.mouse.click(5, 5)
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(body).toHaveValue('Draft text')

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
})

test('import dialog stays centered and fits the app viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 768 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import text' })

  for (const viewport of [
    { width: 1365, height: 768 },
    { width: 420, height: 360 },
  ]) {
    await page.setViewportSize(viewport)
    const bounds = await dialog.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height, viewportWidth: innerWidth, viewportHeight: innerHeight }
    })
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(bounds.viewportWidth)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(bounds.viewportHeight)
    expect(Math.abs(bounds.x + bounds.width / 2 - bounds.viewportWidth / 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(bounds.y + bounds.height / 2 - bounds.viewportHeight / 2)).toBeLessThanOrEqual(1)
  }

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
})

test('imports a text and shows it', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import text' })
  await expect(dialog).toBeVisible()
  const fileChooserPromise = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: 'Choose a text file' }).click()
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles({
    name: 'market-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Apples were expensive.\n\nI bought three and walked home.\n'),
  })
  await expect(dialog.locator('#import-file-name')).toHaveText('market-notes.txt')
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
  await expect(theme).toHaveAttribute('aria-label', 'Switch to dark theme')
  await theme.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(theme).toHaveAttribute('aria-label', 'Switch to light theme')

  await page.locator('#font-size').fill('44')
  await expect(page.locator('#font-size-value')).toHaveText('44')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--script-size').trim())).toBe('44px')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('#theme')).toHaveAttribute('aria-label', 'Switch to light theme')
  await expect(page.locator('#font-size')).toHaveValue('44')
  await expect(page.locator('#font-size-value')).toHaveText('44')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--script-size').trim())).toBe('44px')
})

test('a recorded take does not start with a long block of digital zeros', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Voice enhance')).toHaveCount(0)
  await expect(page.locator('#takes-list')).toContainText('No takes yet')

  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.locator('#rec')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await page.locator('#recorder-clock').innerText()).trim()).not.toBe('00:00.00')
  await page.waitForTimeout(700)
  await page.locator('#recorder-panel').getByRole('button', { name: 'Stop recording' }).click()
  await expect(page.locator('#takes-list .take-row')).toHaveCount(1)

  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.locator('#rec')).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(400)
  await page.locator('#recorder-panel').getByRole('button', { name: 'Stop recording' }).click()
  await expect(page.locator('#takes-list .take-row')).toHaveCount(2)

  const leading = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('teleprompter')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const takes = await new Promise((resolve, reject) => {
      const tx = db.transaction('takes', 'readonly')
      const request = tx.objectStore('takes').getAll()
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })
    if (!takes.length) throw new Error('take has no audio')
    const ctx = new AudioContext()
    try {
      const measured = []
      for (const take of takes) {
        if (!take?.blob?.arrayBuffer) throw new Error('take has no audio')
        const audio = await ctx.decodeAudioData(await take.blob.arrayBuffer())
        const data = audio.getChannelData(0)
        let i = 0
        const limit = Math.min(data.length, audio.sampleRate)
        while (i < limit && data[i] === 0) i += 1
        measured.push({ leadingMs: (i / audio.sampleRate) * 1000, samples: data.length })
      }
      return measured
    } finally {
      await ctx.close()
    }
  })
  expect(leading).toHaveLength(2)
  for (const take of leading) {
    expect(take.samples).toBeGreaterThan(0)
    expect(take.leadingMs, `leading digital zeros were ${take.leadingMs.toFixed(1)} ms`).toBeLessThan(50)
  }
})

test('a short recording creates a take', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#takes-list')).toContainText('No takes yet')

  await page.getByRole('button', { name: 'Start recording' }).click()
  await expect(page.locator('#rec')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#recorder-panel')).toHaveAttribute('data-mode', 'recording')
  await expect(page.locator('#run')).toHaveText('Pause')
  await expect.poll(async () => (await page.locator('#recorder-clock').innerText()).trim()).not.toBe('00:00.00')

  const clockBeforeReaderPause = (await page.locator('#recorder-clock').innerText()).trim()
  await page.locator('#run').click()
  await expect(page.locator('#run')).toHaveText('Run')
  await expect.poll(async () => (await page.locator('#recorder-clock').innerText()).trim()).not.toBe(clockBeforeReaderPause)

  await page.locator('#recorder-panel').getByRole('button', { name: 'Stop recording' }).click()
  await expect(page.locator('#takes-list .take-row')).toHaveCount(1)
  await expect(page.locator('#takes-list .take-select')).toBeVisible()
  await expect(page.locator('#takes-list .take-options')).toHaveCount(0)
  await expect(page.locator('#takes-list')).not.toContainText('No takes yet')
  await expect.poll(() => page.locator('.take-select').evaluate((node) => getComputedStyle(node).appearance)).toBe('none')

  const take = page.locator('#takes-list .take-select')
  const box = await take.boundingBox()
  await take.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', clientX: box.x + 20, clientY: box.y + 20 })
  await page.waitForTimeout(550)
  await expect(page.locator('.row-menu')).toBeVisible()
  await take.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', clientX: box.x + 20, clientY: box.y + 20 })
})

test('microphone picker uses the themed sheet and applies a choice immediately', async ({ page }) => {
  await page.goto('/')
  const trigger = page.locator('#mic-idle')
  await trigger.click()
  const picker = page.locator('#mic-picker')
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('dialog')).toBeVisible()
  const selected = picker.getByRole('radio', { checked: true })
  await expect(selected).toHaveCount(1)
  await selected.click()
  await expect(picker).toBeHidden()
  await expect(trigger).toBeFocused()
})
