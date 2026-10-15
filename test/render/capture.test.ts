import { EventEmitter } from 'node:events'
import type { Page } from 'playwright'
import { expect, test } from 'vitest'
import { capturePng } from '../../src/render/capture.js'

/** A page that records the CDP commands sent to it and can fire `load`. */
function fakePage() {
  const sent: { method: string; params: unknown }[] = []
  const cdp = {
    send: async (method: string, params: unknown) => {
      sent.push({ method, params })
      return method === 'Page.captureScreenshot' ? { data: Buffer.from('png').toString('base64') } : {}
    },
  }
  const events = new EventEmitter()
  const page = {
    context: () => ({ newCDPSession: async () => cdp }),
    on: (event: string, cb: () => void) => events.on(event, cb),
  } as unknown as Page
  const overrides = () => sent.filter((s) => s.method === 'Emulation.setDefaultBackgroundColorOverride').map((s) => s.params)
  return { page, overrides, emit: (event: string) => events.emit(event), listeners: (event: string) => events.listenerCount(event) }
}

const size = { width: 4, height: 2, pixelRatio: 1 }
const CLEAR = { color: { r: 0, g: 0, b: 0, a: 0 } }

test('sends the background override only when it changes', async () => {
  const { page, overrides, emit, listeners } = fakePage()
  expect((await capturePng(page, { ...size, transparent: true })).toString()).toBe('png')
  await capturePng(page, { ...size, transparent: true })
  expect(overrides()).toEqual([CLEAR])
  await capturePng(page, { ...size, transparent: false })
  expect(overrides()).toEqual([CLEAR, {}])
  await capturePng(page, size)
  expect(overrides()).toEqual([CLEAR, {}])

  // A page load resets the override, so the next capture sends it again.
  emit('load')
  await capturePng(page, size)
  expect(overrides()).toEqual([CLEAR, {}, {}])
  expect(listeners('load')).toBe(1)
})
