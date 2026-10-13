import { MAP_CREDIT, type FrameState, type LngLat, type Project, type Stop } from '../../core/index.js'

/** Fonts the overlay draws with. Callers load them before drawing so text never falls back mid-render. */
export const SIGN_FONT = '600 26px Inter'
export const CREDIT_FONT = '400 14px Inter'

// Sizes in layout px.
const DOT_RADIUS = 6
const TERMINAL_SCALE = 1.5
const DOT_STROKE = 2.5
const TAG = {
  radius: 6,
  fill: 'rgba(255, 255, 255, 0.92)',
  text: '#1d2430',
  padX: 16,
  padY: 10,
  /** Height of the text line inside the padding. */
  lineHeight: 26,
  pointer: 10,
  pointerHalfWidth: 8,
  /** Gap from the dot's centre to the bottom of the box. */
  lift: 16,
}
const CREDIT = { margin: 16, color: 'rgba(255, 255, 255, 0.85)', shadow: 'rgba(0, 0, 0, 0.7)', shadowBlur: 2 }

export interface OverlayArgs {
  project: Project
  state: FrameState
  /** Layout-px position of a coordinate on the current map view. */
  project2px: (p: LngLat) => [number, number]
  /** Device px per layout px: the canvas backing store is the layout size times this. */
  pixelRatio: number
}

/** The text a stop's sign shows. */
export const signText = (stop: Stop) => stop.label ?? stop.name

/** Clears the overlay canvas and draws stop dots, signs and (when burned in) the map credit. */
export function drawOverlay(ctx: CanvasRenderingContext2D, args: OverlayArgs): void {
  const { project, state, project2px, pixelRatio } = args
  const width = ctx.canvas.width / pixelRatio
  const height = ctx.canvas.height / pixelRatio
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

  const color = project.look.line.color
  for (const stop of project.stops) {
    drawDot(ctx, project2px(stop.at), stop.terminal ? DOT_RADIUS * TERMINAL_SCALE : DOT_RADIUS, color)
  }

  const stops = new Map(project.stops.map((s) => [s.id, s]))
  for (const sign of state.signs) {
    const stop = stops.get(sign.stopId)
    if (!stop || sign.opacity <= 0) continue
    drawTag(ctx, project2px(stop.at), signText(stop), sign.opacity)
  }

  if (project.credit === 'burned') drawCredit(ctx, width, height, pixelRatio)
}

function drawDot(ctx: CanvasRenderingContext2D, [x, y]: [number, number], radius: number, color: string): void {
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, 2 * Math.PI)
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = DOT_STROKE
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
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
  ctx.fillStyle = TAG.fill
  ctx.fill()

  ctx.fillStyle = TAG.text
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, top + boxHeight / 2)
  ctx.restore()
}

function drawCredit(ctx: CanvasRenderingContext2D, width: number, height: number, pixelRatio: number): void {
  ctx.save()
  ctx.font = CREDIT_FONT
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = CREDIT.color
  // Shadows ignore the canvas transform, so they are given in device px.
  ctx.shadowColor = CREDIT.shadow
  ctx.shadowBlur = CREDIT.shadowBlur * pixelRatio
  ctx.fillText(MAP_CREDIT, width - CREDIT.margin, height - CREDIT.margin)
  ctx.restore()
}
