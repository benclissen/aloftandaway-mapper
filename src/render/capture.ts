import type { CDPSession, Page } from 'playwright'

interface PageCapture {
  cdp?: Promise<CDPSession>
  /** The `transparent` value whose background override the page has. Unset when none is known to be in force. */
  transparent?: boolean
}

const captures = new WeakMap<Page, PageCapture>()

/** The page's capture state and CDP session. A session that failed to open is retried on the next capture. */
function captureState(page: Page): { state: PageCapture; cdp: Promise<CDPSession> } {
  let state = captures.get(page)
  if (!state) {
    const created: PageCapture = {}
    state = created
    captures.set(page, created)
    // A page load may reset the override, so the next capture sends it again.
    page.on('load', () => {
      created.transparent = undefined
    })
  }
  let cdp = state.cdp
  if (!cdp) {
    const opened = page.context().newCDPSession(page)
    const owner = state
    owner.cdp = opened
    opened.catch(() => {
      if (owner.cdp === opened) owner.cdp = undefined
    })
    cdp = opened
  }
  return { state, cdp }
}

/**
 * Captures the frame as a PNG over CDP. `width` and `height` are the layout size in CSS px; the PNG is that times
 * `pixelRatio`. The page must lay the frame out at its top-left corner. The background override is sent only when
 * `transparent` differs from the last capture on this page.
 */
export async function capturePng(
  page: Page,
  args: { width: number; height: number; pixelRatio: number; transparent?: boolean },
): Promise<Buffer> {
  const session = captureState(page)
  const { state } = session
  const cdp = await session.cdp
  const transparent = args.transparent ?? false
  if (state.transparent !== transparent) {
    state.transparent = undefined
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {})
    state.transparent = transparent
  }
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    optimizeForSpeed: true,
    clip: { x: 0, y: 0, width: args.width, height: args.height, scale: args.pixelRatio },
  })
  return Buffer.from(data, 'base64')
}
