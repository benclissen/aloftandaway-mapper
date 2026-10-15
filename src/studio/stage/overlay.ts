import {
  effectiveSymbol,
  sceneCredit,
  SIGN_TAG as TAG,
  signText,
  SYMBOL_FACING,
  SYMBOL_ICON,
  symbolStyleOf,
  type FrameState,
  type LngLat,
  type Project,
  type Scene,
  type RenderLayer,
} from '../../core/index.js'
import { ICONS, type IconName } from './icons.js'

/** Fonts the overlay draws with. Callers load them before drawing so text never falls back mid-render. */
export const SIGN_FONT = '600 26px "Plus Jakarta Sans"'
export const CREDIT_FONT = '500 14px "Plus Jakarta Sans"'

// Sizes in layout px.
const DOT_RADIUS = 6
const TERMINAL_SCALE = 1.5
const DOT_STROKE = 2.5
const NAVY = '#0a2434'
const WHITE = '#ffffff'
const BADGE_RADIUS = 22
const BADGE_RING = 3
/** The icon grid's 24 units are drawn this many layout px across. */
const ICON_SIZE = 26
const ICON_GRID = 24
/** Stroke widths: the icon's own, in icon units, and the white halo behind a bare icon, in layout px. */
const ICON_STROKE = 2.2
const ICON_HALO = 6
/** Degrees to add to a turning icon's rotation so its drawing points along the heading. */
const TURN_OFFSET = { right: -90, 'north-east': -45, up: 0, front: 0 } as const
const TAG_STYLE = { fill: 'rgba(255, 255, 255, 0.92)', text: '#1d2430' }
export const CREDIT = { margin: 16, fill: 'rgba(255, 255, 255, 0.92)', halo: 'rgba(20, 24, 32, 0.7)', haloWidth: 3, lineHeight: 20 }

export interface OverlayArgs {
  layer?: RenderLayer
  scene: Scene
  credit: Project['credit']
  state: FrameState
  /** Layout-px position of a coordinate on the current map view: on the ground, when the map has terrain. */
  project2px: (p: LngLat) => [number, number]
  /** Index of the leg the head is on, for its symbol. */
  legIndex?: number
  /** Whether side-view symbols face west on that leg. */
  flipped?: boolean
  /** The map's bearing in degrees clockwise from north, which turning symbols subtract from the heading. */
  bearing?: number
  /** Device px per layout px: the canvas backing store is the layout size times this. */
  pixelRatio: number
}

export { signText }

/** Clears the overlay canvas and draws stop dots, signs and (when burned in) the map credit. */
export function drawOverlay(ctx: CanvasRenderingContext2D, args: OverlayArgs): void {
  const { scene, state, project2px, pixelRatio } = args
  const width = ctx.canvas.width / pixelRatio
  const height = ctx.canvas.height / pixelRatio
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

  const layer = args.layer ?? 'all'
  const dots = layer === 'route' || layer === 'all'
  const signs = layer === 'signs' || layer === 'all'
  const credit = layer === 'map' || layer === 'all'
  const color = scene.look.line.color
  // The plain dot sits under the stop dots, as the old map-layer head did; a vehicle sits on top of them.
  const head = dots && state.head ? project2px(state.head.at) : undefined
  const dotHead = effectiveSymbol(scene, args.legIndex ?? 0) === 'dot'
  if (head && dotHead) drawVehicle(ctx, head, args)
  if (dots) {
    for (const stop of scene.stops) {
      drawDot(ctx, project2px(stop.at), stop.terminal ? DOT_RADIUS * TERMINAL_SCALE : DOT_RADIUS, color)
    }
  }

  if (head && !dotHead) drawVehicle(ctx, head, args)

  const stops = new Map(scene.stops.map((s) => [s.id, s]))
  if (signs) {
    for (const sign of state.signs) {
      const stop = stops.get(sign.stopId)
      if (!stop || sign.opacity <= 0) continue
      drawTag(ctx, project2px(stop.at), signText(stop), sign.opacity)
    }
  }

  if (credit && args.credit === 'burned') drawCredit(ctx, sceneCredit(scene), width, height)
}

function drawDot(ctx: CanvasRenderingContext2D, [x, y]: [number, number], radius: number, color: string, ring = DOT_STROKE): void {
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, 2 * Math.PI)
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = ring
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
}

/** The scene's symbol for the head's leg: the old dot, a badge, or a bare icon. Side views mirror, turning icons rotate. */
function drawVehicle(ctx: CanvasRenderingContext2D, [x, y]: [number, number], args: OverlayArgs): void {
  const { scene, state } = args
  const symbol = effectiveSymbol(scene, args.legIndex ?? 0)
  if (symbol === 'none') return
  const { color, width } = scene.look.line
  if (symbol === 'dot') {
    drawDot(ctx, [x, y], Math.max(5, width * 1.5), color, 2)
    return
  }
  const icon = ICONS[SYMBOL_ICON[symbol] as IconName]
  const style = symbolStyleOf(scene.look)
  const facing = SYMBOL_FACING[symbol]

  ctx.save()
  ctx.translate(x, y)
  if (style !== 'icon') {
    ctx.beginPath()
    ctx.arc(0, 0, BADGE_RADIUS + BADGE_RING, 0, 2 * Math.PI)
    ctx.fillStyle = WHITE
    ctx.fill()
    ctx.beginPath()
    ctx.arc(0, 0, BADGE_RADIUS, 0, 2 * Math.PI)
    ctx.fillStyle = style === 'badge-line' ? color : NAVY
    ctx.fill()
  }
  // Heading is degrees clockwise from north, as is canvas rotation, so heading minus bearing is the on-screen angle.
  if (facing === 'turn') ctx.rotate(((state.head.heading - (args.bearing ?? 0) + TURN_OFFSET[icon.facing]) * Math.PI) / 180)
  else if (facing === 'side' && args.flipped) ctx.scale(-1, 1)
  const scale = ICON_SIZE / ICON_GRID
  ctx.scale(scale, scale)
  ctx.translate(-ICON_GRID / 2, -ICON_GRID / 2)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const paths = icon.paths.map((d) => new Path2D(d))
  if (style === 'icon') {
    ctx.lineWidth = ICON_HALO / scale
    ctx.strokeStyle = WHITE
    for (const path of paths) ctx.stroke(path)
  }
  ctx.lineWidth = ICON_STROKE
  ctx.strokeStyle = style === 'icon' ? NAVY : WHITE
  for (const path of paths) ctx.stroke(path)
  ctx.restore()
}

/** A rounded label box above the dot, with a pointer down towards it. */
function drawTag(ctx: CanvasRenderingContext2D, [x, y]: [number, number], text: string, opacity: number): void {
  ctx.save()
  ctx.globalAlpha = opacity
  ctx.font = SIGN_FONT
  const boxWidth = ctx.measureText(text).width + 2 * TAG.padX
  const boxHeight = TAG.lineHeight + 2 * TAG.padY
  const bottom = y - TAG.lift
  const left = x - boxWidth / 2
  const top = bottom - boxHeight

  ctx.beginPath()
  ctx.roundRect(left, top, boxWidth, boxHeight, TAG.radius)
  ctx.moveTo(x - TAG.pointerHalfWidth, bottom)
  ctx.lineTo(x, bottom + TAG.pointer)
  ctx.lineTo(x + TAG.pointerHalfWidth, bottom)
  ctx.closePath()
  ctx.fillStyle = TAG_STYLE.fill
  ctx.fill()

  ctx.fillStyle = TAG_STYLE.text
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, top + boxHeight / 2)
  ctx.restore()
}

/** White text on a dark halo, so the credit reads on light and dark maps alike. One right-aligned line each, the last at the bottom. */
function drawCredit(ctx: CanvasRenderingContext2D, lines: readonly string[], width: number, height: number): void {
  if (lines.length === 0) return
  ctx.save()
  ctx.font = CREDIT_FONT
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  ctx.strokeStyle = CREDIT.halo
  ctx.lineWidth = CREDIT.haloWidth
  ctx.lineJoin = 'round'
  ctx.fillStyle = CREDIT.fill
  const x = width - CREDIT.margin
  lines.forEach((line, i) => {
    const y = height - CREDIT.margin - (lines.length - 1 - i) * CREDIT.lineHeight
    ctx.strokeText(line, x, y)
    ctx.fillText(line, x, y)
  })
  ctx.restore()
}
