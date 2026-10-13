import { chromium, type Browser } from 'playwright'

/** Chrome flags. The render-speed benchmark found the defaults already use the GPU (ANGLE on Metal). */
const LAUNCH_ARGS: string[] = []

/** Mapper owns shutdown: Playwright's own signal handlers would exit the process before renders are cancelled. */
const NO_SIGNAL_HANDLERS = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }

export interface LaunchedBrowser {
  browser: Browser
  channel: 'chrome' | 'chromium'
  /** The WebGL renderer string, for spotting software rendering. */
  webgl: string
}

/** Launches headless Google Chrome, or Playwright's bundled Chromium when Chrome isn't installed. */
export async function launchBrowser(): Promise<LaunchedBrowser> {
  let browser: Browser
  let channel: LaunchedBrowser['channel']
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: LAUNCH_ARGS, ...NO_SIGNAL_HANDLERS })
    channel = 'chrome'
  } catch (chromeError) {
    try {
      browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS, ...NO_SIGNAL_HANDLERS })
      channel = 'chromium'
    } catch (chromiumError) {
      throw new Error(
        `Could not start Google Chrome (${firstLine(chromeError)}) or Playwright's Chromium (${firstLine(chromiumError)}). ` +
          'Install Google Chrome, or run `npx playwright install chromium`.',
      )
    }
  }
  try {
    return { browser, channel, webgl: await webglRenderer(browser) }
  } catch (e) {
    await browser.close()
    throw e
  }
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? ''
}

async function webglRenderer(browser: Browser): Promise<string> {
  const page = await browser.newPage()
  try {
    // A string, because this module is type-checked without the DOM library.
    const renderer = await page.evaluate(`(() => {
      const gl = document.createElement('canvas').getContext('webgl2')
      if (!gl) return 'none'
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      return String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    })()`)
    return String(renderer)
  } finally {
    await page.close()
  }
}
