import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MAP_DATA_ERROR } from '../../src/core/index.js'
import { waitForStyleLoad, type StyleEvents } from '../../src/studio/stage/style-load.js'

/** A map that only emits what the test fires. */
function fakeMap() {
  const listeners = new Map<string, Set<() => void>>()
  const map: StyleEvents = {
    on: (type, fn) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
    off: (type, fn) => void listeners.get(type)?.delete(fn),
  }
  return {
    map,
    fire: (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn()),
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  }
}

const noError = () => undefined

describe('waiting for a style to load', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  // `style.load` does not wait for any network request (the style is an inline object with no sprite, and its tiles
  // and glyphs load afterwards), so the page can't be made to stall on a held request. This is the timeout's test.
  test('a style that never loads rejects with the map-data error after the timeout', async () => {
    const { map, count } = fakeMap()
    const waiting = waitForStyleLoad(map, 60_000, noError)
    const outcome = waiting.then(() => 'loaded', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(count()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    await expect(outcome).resolves.toBe(`${MAP_DATA_ERROR} the map style did not load within 60 s.`)
    expect(count()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('the timeout names the time it was given', async () => {
    const { map } = fakeMap()
    const waiting = expect(waitForStyleLoad(map, 2000, noError)).rejects.toThrow('did not load within 2 s.')
    await vi.advanceTimersByTimeAsync(2000)
    await waiting
  })

  test('a style that loads resolves and leaves nothing listening', async () => {
    const { map, fire, count } = fakeMap()
    const waiting = waitForStyleLoad(map, 60_000, noError)
    fire('style.load')
    await expect(waiting).resolves.toBeUndefined()
    expect(count()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a map error while loading rejects with the stage\'s map-data error at once', async () => {
    const { map, fire, count } = fakeMap()
    const throwMapError = () => {
      throw new Error(`${MAP_DATA_ERROR}: AJAXError: Forbidden (403): http://x/tiles/planet`)
    }
    const waiting = expect(waitForStyleLoad(map, 60_000, throwMapError)).rejects.toThrow(`${MAP_DATA_ERROR}: AJAXError: Forbidden (403)`)
    fire('error')
    await waiting
    expect(count()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a map error that the stage has no record of still fails the load', async () => {
    const { map, fire } = fakeMap()
    const waiting = expect(waitForStyleLoad(map, 60_000, noError)).rejects.toThrow(MAP_DATA_ERROR)
    fire('error')
    await waiting
  })

  test('MapStage waits for the style with it, for 60 s', () => {
    // MapStage needs a DOM and WebGL, so a unit test can't run it; the e2e render tests cover its normal path.
    const source = readFileSync(new URL('../../src/studio/stage/MapStage.ts', import.meta.url), 'utf8')
    expect(source).toContain('const STYLE_TIMEOUT_MS = 60_000')
    expect(source).toMatch(/const styled = waitForStyleLoad\(this\.map, STYLE_TIMEOUT_MS, \(\) => this\.throwMapError\(\)\)\s+this\.map\.setStyle\(/)
  })
})
