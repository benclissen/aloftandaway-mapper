import type { Scene, Stop } from './schema.js'
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

/** Clear space kept between a sign's box and the edge of the symbol below it, in layout px. */
const SIGN_CLEARANCE = 6

/**
 * How far above its dot a sign's box sits in this scene: the tag's own lift, or enough to clear the biggest symbol the
 * scene draws (the look's symbol and every leg's override), whichever is higher.
 */
export function signLift(scene: Scene): number {
  const style = symbolStyleOf(scene.look)
  const symbols = [scene.look.symbol, ...scene.legs.flatMap((leg) => (leg.symbol ? [leg.symbol] : []))]
  return Math.max(SIGN_TAG.lift, SIGN_CLEARANCE + Math.max(...symbols.map((symbol) => vehicleRadius(symbol, style))))
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
