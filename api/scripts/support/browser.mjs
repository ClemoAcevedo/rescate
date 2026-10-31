// Conserva los recorridos existentes; solo instrumenta Chromium al pedir cobertura.
import { chromium as playwrightChromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

export const chromium = process.env.WEB_COVERAGE_DIR ? {
  async launch(options) {
    const browser = await playwrightChromium.launch(options)
    const tracked = new Map()
    const capture = async (page, restart = false) => {
      if (!tracked.has(page)) return
      tracked.delete(page)
      const entries = (await page.coverage.stopJSCoverage()).filter(entry => /\/src\/.*\.(ts|tsx)(\?|$)/.test(entry.url))
      if (restart) {
        await page.coverage.startJSCoverage({ resetOnNavigation: false })
        tracked.set(page, true)
      }
      if (!entries.length) return
      const dir = resolve(process.env.WEB_COVERAGE_DIR)
      await mkdir(dir, { recursive: true })
      await writeFile(resolve(dir, `${process.pid}-${randomUUID()}.json`), JSON.stringify(entries))
    }
    const context = browser.newContext.bind(browser)
    browser.newContext = async options => {
      const result = await context(options)
      const newPage = result.newPage.bind(result)
      result.newPage = async () => {
        const page = await newPage()
        await page.coverage.startJSCoverage({ resetOnNavigation: false })
        tracked.set(page, true)
        // V8 puede descartar los contadores del contexto anterior al navegar, aunque
        // Playwright conserve sus fuentes con resetOnNavigation=false.
        for (const method of ['goto', 'reload', 'goBack', 'goForward']) {
          const navigate = page[method].bind(page)
          page[method] = async (...args) => { await capture(page, true); return navigate(...args) }
        }
        const close = page.close.bind(page)
        page.close = async options => { await capture(page); return close(options) }
        return page
      }
      const close = result.close.bind(result)
      result.close = async options => {
        for (const page of result.pages()) await capture(page)
        return close(options)
      }
      return result
    }
    // Browser.newPage crea un contexto implícito y no pasa por newContext.
    browser.newPage = async options => (await browser.newContext(options)).newPage()
    const close = browser.close.bind(browser)
    browser.close = async options => {
      try {
        for (const ctx of browser.contexts()) for (const page of ctx.pages()) await capture(page)
      } finally { await close(options) }
    }
    return browser
  },
} : playwrightChromium
