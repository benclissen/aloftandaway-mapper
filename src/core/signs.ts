import type { Stop } from './schema.js'

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

/** The text a stop's sign shows. */
export const signText = (stop: Stop): string => stop.label ?? stop.name

/** Average glyph width as a fraction of the font size, for estimating a sign's width without a canvas. */
const GLYPH_WIDTH = 0.6

/** The layout-px box of a sign above the dot at `px`, with its width estimated from the text length. */
export function signBox(
  px: [number, number],
  text: string,
): { left: number; top: number; right: number; bottom: number } {
  const width = text.length * GLYPH_WIDTH * SIGN_TAG.fontPx + 2 * SIGN_TAG.padX
  const height = SIGN_TAG.lineHeight + 2 * SIGN_TAG.padY
  const bottom = px[1] - SIGN_TAG.lift
  return { left: px[0] - width / 2, top: bottom - height, right: px[0] + width / 2, bottom }
}
