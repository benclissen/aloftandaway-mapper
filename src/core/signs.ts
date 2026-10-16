import type { Scene, Stop } from './schema.js'
import { effectiveSymbol } from './route.js'
import { symbolStyleOf, vehicleRadius } from './symbols.js'

/** Sizes of a stop's sign tag in layout px. The studio overlay draws with these, and validation measures with them. */
export const SIGN_TAG = {
  fontPx: 26,
  padX: 16,
  padY: 10,
  /** Height of the text line inside the padding. */
  lineHeight: 26,
  /** Gap from the dot's centre to the bottom of the box. */
  lift: 16,
  pointer: 10,
  pointerHalfWidth: 8,
  radius: 6,
}

/** Clear space kept between a sign's pointer tip and the edge of the symbol below it, in layout px. */
const SIGN_CLEARANCE = 6

/**
 * How far above its dot a sign's box sits in this scene: the tag's own lift, or enough that the pointer tip clears the
 * biggest badge or icon the scene draws (each leg's own symbol, else the look's; a scene with no legs uses the look's)
 * by 6 px, whichever is higher. A plain dot or no symbol never raises it.
 */
export function signLift(scene: Scene): number {
  const style = symbolStyleOf(scene.look)
  const symbols = scene.legs.length > 0 ? scene.legs.map((_, i) => effectiveSymbol(scene, i)) : [scene.look.symbol]
  const radii = symbols.filter((s) => s !== 'dot' && s !== 'none').map((s) => vehicleRadius(s, style))
  const r = Math.max(0, ...radii)
  return Math.max(SIGN_TAG.lift, r + SIGN_TAG.pointer + SIGN_CLEARANCE)
}

/** The text a stop's sign shows. */
export const signText = (stop: Stop): string => stop.label ?? stop.name

/** Average glyph width as a fraction of the font size, for estimating a sign's width without a canvas. */
const GLYPH_WIDTH = 0.6

/** The layout-px box of a sign `lift` px above the dot at `px`, with its width estimated from the text length. */
export function signBox(
  px: [number, number],
  text: string,
  lift: number = SIGN_TAG.lift,
): { left: number; top: number; right: number; bottom: number } {
  const width = text.length * GLYPH_WIDTH * SIGN_TAG.fontPx + 2 * SIGN_TAG.padX
  const height = SIGN_TAG.lineHeight + 2 * SIGN_TAG.padY
  const bottom = px[1] - lift
  return { left: px[0] - width / 2, top: bottom - height, right: px[0] + width / 2, bottom }
}
