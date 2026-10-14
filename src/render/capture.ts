import type { CDPSession, Page } from 'playwright'

const sessions = new WeakMap<Page, Promise<CDPSession>>()

function session(page: Page): Promise<CDPSession> {
  let cdp = sessions.get(page)
  if (!cdp) {
    cdp = page.context().newCDPSession(page)
    sessions.set(page, cdp)
    cdp.catch(() => sessions.delete(page))
  }
  return cdp
}

/**
 * Captures the frame as a PNG over CDP. `width` and `height` are the layout size in CSS px; the PNG is that times
 * `pixelRatio`. The page must lay the frame out at its top-left corner.
 */
export async function capturePng(
  page: Page,
  args: { width: number; height: number; pixelRatio: number; transparent?: boolean },
): Promise<Buffer> {
  const cdp = await session(page)
  await cdp.send(
    'Emulation.setDefaultBackgroundColorOverride',
    args.transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {},
  )
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    optimizeForSpeed: true,
    clip: { x: 0, y: 0, width: args.width, height: args.height, scale: args.pixelRatio },
  })
  return Buffer.from(data, 'base64')
}
