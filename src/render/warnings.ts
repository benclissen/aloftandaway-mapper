/**
 * What went wrong in a render without failing it. `unsettled` are frames whose camera height over terrain never held
 * still, numbered within their scene. `other` are finished lines, for anything else.
 */
export type RenderWarnings = { unsettled: number[]; other: string[] }

export const NO_WARNINGS: RenderWarnings = { unsettled: [], other: [] }

/** At most this many frame numbers are listed; the rest are counted. */
const MAX_LISTED_FRAMES = 10

/**
 * Both sets of warnings. The same frame can come from several layer passes, each on its own page, so the frames are
 * a sorted union. `other` lines are appended.
 */
export function mergeWarnings(a: RenderWarnings, b: RenderWarnings): RenderWarnings {
  return {
    unsettled: [...new Set([...a.unsettled, ...b.unsettled])].sort((x, y) => x - y),
    other: [...a.other, ...b.other],
  }
}

/**
 * One line for the unsettled frames, then each `other` line; nothing when there are none. `scene` (e.g.
 * `Scene 2 of 2 · Sail`) prefixes the frames' line, since frame numbers are the scene's own.
 */
export function describeWarnings(w: RenderWarnings, scene?: string): string[] {
  const lines: string[] = []
  if (w.unsettled.length > 0) {
    const line = unsettledLine(w.unsettled)
    lines.push(scene ? `${scene}: ${line[0]!.toLowerCase()}${line.slice(1)}` : line)
  }
  return [...lines, ...w.other]
}

function unsettledLine(frames: number[]): string {
  const listed = frames.slice(0, MAX_LISTED_FRAMES).map(String)
  const rest = frames.length - listed.length
  const items = rest > 0 ? [...listed, `${rest} more`] : listed
  const list = items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`
  return frames.length === 1
    ? `Frame ${list}: the camera height over terrain hadn't settled, so this frame may differ slightly between renders and between layers.`
    : `Frames ${list}: the camera height over terrain hadn't settled, so these frames may differ slightly between renders and between layers.`
}
