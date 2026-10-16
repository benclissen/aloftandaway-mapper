import { describe, expect, test } from 'vitest'
import { MAP_CREDIT, SATELLITE_CREDIT, screenAngle, TERRAIN_CREDIT, type FrameState } from '../../src/core/index.js'
import { drawOverlay } from '../../src/studio/stage/overlay.js'
import { emptyProject, sceneOf } from '../fixtures/projects.js'

interface TextCall { text: string; x: number; y: number; align: string }

/** A canvas context that records the text it is asked to draw. */
function recorder(width: number, height: number) {
  const fills: TextCall[] = []
  const strokes: TextCall[] = []
  const ctx = new Proxy({ canvas: { width, height }, textAlign: 'start' } as Record<string, unknown>, {
    get(target, key: string) {
      if (key === 'fillText') return (text: string, x: number, y: number) => fills.push({ text, x, y, align: String(target.textAlign) })
      if (key === 'strokeText') return (text: string, x: number, y: number) => strokes.push({ text, x, y, align: String(target.textAlign) })
      if (key in target) return target[key]
      return () => undefined
    },
    set(target, key: string, value) {
      target[key] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, fills, strokes }
}

const state = { signs: [] } as unknown as FrameState

function draw(look: { theme?: string; terrain?: boolean }, credit: 'burned' | 'description') {
  const project = emptyProject()
  const scene = structuredClone(sceneOf(project))
  Object.assign(scene.look, look)
  const { ctx, fills, strokes } = recorder(960, 540)
  drawOverlay(ctx, { scene, credit, state, project2px: () => [0, 0], pixelRatio: 1 })
  return { fills, strokes }
}

describe('burned credit', () => {
  test('draws each line right-aligned, the first line topmost and the last at the bottom', () => {
    const { fills, strokes } = draw({ theme: 'satellite', terrain: true }, 'burned')
    expect(fills.map((f) => f.text)).toEqual([MAP_CREDIT, SATELLITE_CREDIT, TERRAIN_CREDIT])
    expect(strokes.map((f) => f.text)).toEqual(fills.map((f) => f.text))
    expect(new Set(fills.map((f) => f.x))).toEqual(new Set([960 - 16]))
    expect(fills.every((f) => f.align === 'right')).toBe(true)
    expect(fills[2].y).toBe(540 - 16)
    expect(fills[1].y).toBeLessThan(fills[2].y)
    expect(fills[0].y).toBeLessThan(fills[1].y)
  })

  test('draws only the map line for a plain map style', () => {
    expect(draw({ theme: 'paper', terrain: false }, 'burned').fills.map((f) => f.text)).toEqual([MAP_CREDIT])
  })

  test('draws nothing for the blank style, or when the credit goes in the description', () => {
    expect(draw({ theme: 'blank', terrain: false }, 'burned').fills).toEqual([])
    expect(draw({ theme: 'paper', terrain: false }, 'description').fills).toEqual([])
  })
})

describe('vehicle orientation', () => {
  /**
   * Draws the head with a symbol and returns the rotations the canvas was given, in degrees, and whether it was mirrored
   * left to right (side views) or top to bottom (a side view that turns, heading west on screen).
   */
  function orientation(
    symbol: 'plane' | 'helicopter' | 'balloon' | 'car' | 'arrow',
    opts: { heading: number; bearing?: number; flipped?: boolean; screenAngle?: number },
  ) {
    const scene = structuredClone(sceneOf(emptyProject()))
    scene.look.symbol = symbol
    const rotations: number[] = []
    const scales: Array<[number, number]> = []
    const canvas = { width: 960, height: 540 }
    const ctx = new Proxy({ canvas } as Record<string, unknown>, {
      get: (target, key: string) => {
        // Rounded, so a round trip through radians doesn't leave float noise.
        if (key === 'rotate') return (rad: number) => rotations.push(Math.round((rad * 180 * 1e9) / Math.PI) / 1e9)
        if (key === 'scale') return (x: number, y: number) => scales.push([x, y])
        return key in target ? target[key] : () => undefined
      },
      set: (target, key: string, value) => ((target[key] = value), true),
    }) as unknown as CanvasRenderingContext2D
    const state = { signs: [], head: { at: [0, 0], heading: opts.heading } } as unknown as FrameState
    ;(globalThis as { Path2D?: unknown }).Path2D ??= class {}
    drawOverlay(ctx, {
      scene,
      credit: 'description',
      state,
      project2px: () => [10, 10],
      pixelRatio: 1,
      bearing: opts.bearing,
      flipped: opts.flipped,
      screenAngle: opts.screenAngle,
    })
    return { rotations, mirrored: scales.some(([x]) => x === -1), upsideDown: scales.some(([, y]) => y === -1) }
  }

  test('a turning icon rotates by heading minus bearing plus its facing offset', () => {
    // The plane's drawing points north-east, the helicopter's east. Heading and bearing are degrees clockwise from north.
    expect(orientation('plane', { heading: 90 }).rotations).toEqual([45])
    expect(orientation('plane', { heading: 90, bearing: 90 }).rotations).toEqual([-45])
    expect(orientation('arrow', { heading: 200, bearing: 20 }).rotations).toEqual([180])
  })

  test('a helicopter turns with its line and is mirrored top to bottom heading west, so its rotor stays on top', () => {
    expect(orientation('helicopter', { heading: 90 })).toMatchObject({ rotations: [0], upsideDown: false })
    expect(orientation('helicopter', { heading: 270 })).toMatchObject({ rotations: [180], upsideDown: true })
    expect(orientation('helicopter', { heading: 300, bearing: 60 })).toMatchObject({ rotations: [150], upsideDown: true })
    // Due north, the leg's own east or west facing decides.
    expect(orientation('helicopter', { heading: 0 })).toMatchObject({ rotations: [-90], upsideDown: false })
    expect(orientation('helicopter', { heading: 0, flipped: true })).toMatchObject({ rotations: [-90], upsideDown: true })
    expect(orientation('helicopter', { heading: 90, screenAngle: 250 })).toMatchObject({ rotations: [160], upsideDown: true })
    // Never mirrored left to right, which would point its nose backwards.
    expect(orientation('helicopter', { heading: 270, flipped: true }).mirrored).toBe(false)
  })

  test('a turning symbol uses the screen angle when given', () => {
    // On a tilted shot the line on screen is not at heading minus bearing; the symbol follows the screen.
    expect(orientation('plane', { heading: 90, bearing: 30, screenAngle: 75 })).toMatchObject({ rotations: [30], upsideDown: false })
    expect(orientation('arrow', { heading: 0, screenAngle: 200 }).rotations).toEqual([200])
  })

  test('a zero-length screen step keeps the map heading', () => {
    const angle = screenAngle([10, 10], [10, 10])
    expect(orientation('plane', { heading: 90, bearing: 30, screenAngle: angle }).rotations).toEqual([15])
  })

  test('side and upright icons never rotate; only side icons mirror', () => {
    expect(orientation('car', { heading: 270, bearing: 30, flipped: true, screenAngle: 240 })).toEqual({ rotations: [], mirrored: true, upsideDown: false })
    expect(orientation('car', { heading: 90 })).toEqual({ rotations: [], mirrored: false, upsideDown: false })
    expect(orientation('balloon', { heading: 270, bearing: 30, flipped: true })).toEqual({ rotations: [], mirrored: false, upsideDown: false })
  })
})

describe('the head on a leg whose symbol is none', () => {
  /** How many circles the overlay draws for the head: stop dots are drawn either way, so count the extra ones. */
  function circles(legIndex: number): number {
    const scene = structuredClone(sceneOf(emptyProject()))
    scene.stops = []
    scene.legs = [{ mode: 'line', via: [], symbol: 'none' }, { mode: 'line', via: [] }]
    scene.look.symbol = 'dot'
    let arcs = 0
    const ctx = new Proxy({ canvas: { width: 960, height: 540 } } as Record<string, unknown>, {
      get: (target, key: string) => (key === 'arc' ? () => arcs++ : key in target ? target[key] : () => undefined),
      set: (target, key: string, value) => ((target[key] = value), true),
    }) as unknown as CanvasRenderingContext2D
    const state = { signs: [], head: { at: [0, 0], heading: 0 } } as unknown as FrameState
    drawOverlay(ctx, { scene, credit: 'description', state, project2px: () => [10, 10], pixelRatio: 1, legIndex })
    return arcs
  }

  test('is not drawn, and is drawn again on the next leg', () => {
    expect(circles(0)).toBe(0)
    expect(circles(1)).toBe(1)
  })
})
