import { chromium } from 'playwright-core'
const executablePath = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1124/chrome-mac/Chromium.app/Contents/MacOS/Chromium`
const browser = await chromium.launch({ headless: true, executablePath })
const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 } })
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 20000 })
await page.waitForTimeout(2500)
for (let i = 0; i < 8; i += 1) {
  const cont = page.getByRole('button', { name: 'Continue' })
  if (await cont.count() > 0) { await cont.first().click(); await page.waitForTimeout(500); continue }
  const dialog = page.getByRole('dialog')
  if (await dialog.count() > 0) { const c = dialog.getByRole('button', { name: 'Close' }); if (await c.count() > 0) { await c.first().click(); await page.waitForTimeout(300); continue } }
  break
}
await page.getByRole('button', { name: 'Bookshelf' }).click()
await page.waitForTimeout(700)
await page.locator('.bs-book', { hasText: '机器学习 Machine Learning' }).locator('.bs-book-title').click()
await page.waitForTimeout(4500)
const read = async () => page.evaluate(() => { const el = document.querySelector('.bs-pdf-scroll'); const canvas = document.querySelector('.bs-pdf-canvas'); return el ? { ratio: el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight), scrollTop: el.scrollTop, max: el.scrollHeight - el.clientHeight, canvas: canvas?.getBoundingClientRect().width } : null })
console.log('initial:', await read())
await page.getByRole('button', { name: 'Notes', exact: true }).click()
await page.waitForTimeout(1200)
console.log('collapsed:', await read())
await page.getByRole('button', { name: 'Notes', exact: true }).click()
await page.waitForTimeout(1200)
console.log('expanded:', await read())
await browser.close()
