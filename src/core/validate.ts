import { cameraAt, projectToLayout, resolveShots } from './camera.js'
import { haversineKm } from './geo.js'
import { buildRoute } from './route.js'
import { THEME_MAX_ZOOM, type Aspect, type Fps, type Project, type Scene } from './schema.js'
import { NO_LAND_DATA, type SeaPaths } from './sea.js'
import { signBox, signLift, signText } from './signs.js'
import { buildTimeline, formatTimecode, legSeconds, SIGN_FADE_SECONDS } from './timeline.js'

export interface Issue {
  code: string
  message: string
  path?: (string | number)[]
  fix?: string
}

/** A leg that lasts less than this many seconds is a warning. */
const MIN_LEG_SECONDS = 1
/** Consecutive stops closer than this many km are reported as the same place. */
const SAME_PLACE_KM = 0.5

/**
 * Checks a project for what blocks a render (errors) and what an agent should fix or explain (warnings). Every scene
 * is checked. Every issue carries a `path` into the project, starting `['scenes', i]`, and a `fix` sentence for the
 * agent. Sea legs are measured along their paths in `opts.seaPaths`, and as lines where they have none.
 */
export function validateProject(
  project: Project,
  opts: { seaPaths?: SeaPaths } = {},
): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  project.scenes.forEach((scene, i) => {
    const prefix = (issue: Issue): Issue => (issue.path ? { ...issue, path: ['scenes', i, ...issue.path] } : issue)
    const found = validateScene(scene, i, project.output.aspect, project.output.fps, opts.seaPaths)
    errors.push(...found.errors.map(prefix))
    warnings.push(...found.warnings.map(prefix))
  })
  return { errors, warnings }
}

/** One warning per pair of signs whose boxes overlap, at the first frame (once each has faded in) where they do. */
function signOverlaps(
  scene: Scene,
  aspect: Aspect,
  fps: Fps,
  route: ReturnType<typeof buildRoute>,
  nameOf: (i: number) => string,
): Issue[] {
  const timeline = buildTimeline(scene, fps, route)
  const fadeFrames = Math.round(SIGN_FADE_SECONDS * (fps.num / fps.den))
  const stopIndex = new Map(scene.stops.map((s, i) => [s.id, i]))
  const lift = signLift(scene)
  const issues: Issue[] = []
  const seen = new Set<string>()
  for (const arrival of timeline.arrivals) {
    if (scene.stops[arrival.index]?.sign === 'none') continue
    const frame = Math.min(arrival.frame + fadeFrames, timeline.totalFrames - 1)
    const shot = cameraAt(scene, aspect, route, timeline, frame)
    const boxes = timeline
      .stateAt(frame)
      .signs.filter((s) => s.opacity > 0)
      .flatMap((s) => {
        const j = stopIndex.get(s.stopId)
        const stop = j === undefined ? undefined : scene.stops[j]
        return stop && j !== undefined ? [{ j, box: signBox(projectToLayout(shot, aspect, stop.at), signText(stop), lift) }] : []
      })
    // Sorted by left edge, so a box can stop looking once the next one starts past its right edge.
    boxes.sort((x, y) => x.box.left - y.box.left)
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length && boxes[b]!.box.left < boxes[a]!.box.right; b++) {
        const [p, q] = [boxes[a]!, boxes[b]!]
        const key = p.j < q.j ? `${p.j}|${q.j}` : `${q.j}|${p.j}`
        if (seen.has(key)) continue
        const hit = p.box.left < q.box.right && q.box.left < p.box.right && p.box.top < q.box.bottom && q.box.top < p.box.bottom
        if (!hit) continue
        seen.add(key)
        issues.push({
          code: 'sign-overlap',
          message: `The ${nameOf(Math.min(p.j, q.j))} and ${nameOf(Math.max(p.j, q.j))} signs overlap at ${formatTimecode(frame, fps)}`,
          path: ['stops', Math.max(p.j, q.j), 'label'],
          fix: "Give one a shorter label with update_stop, set one stop's sign to 'none', or move the camera closer so the stops sit further apart.",
        })
      }
    }
  }
  return issues
}

/** A zoom for a message, rounded up to 2 decimals and trimmed, so a value over the maximum never reads as the maximum. */
const zoomText = (zoom: number): string => String(Math.ceil(zoom * 100 - 1e-9) / 100)

/** Checks one scene, the `index`th. Issue paths are relative to the scene. */
function validateScene(
  scene: Scene,
  index: number,
  aspect: Aspect,
  fps: Fps,
  seaPaths: SeaPaths | undefined,
): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const { stops, camera, look, timing } = scene

  if (stops.length < 2) {
    errors.push({
      code: 'too-few-stops',
      message: `The route has ${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}; it needs at least 2`,
      path: ['stops'],
      fix: 'Add at least two stops with set_stops before rendering.',
    })
  }

  const nameOf = (i: number) => stops[i]?.name || `Stop ${i + 1}`
  const legName = (i: number) => `Leg ${i + 1} (${nameOf(i)} → ${nameOf(i + 1)})`

  if (stops.length >= 2) {
    const route = buildRoute(scene, seaPaths)

    for (let i = 1; i < stops.length; i++) {
      const km = haversineKm(stops[i - 1]!.at, stops[i]!.at)
      if (km < SAME_PLACE_KM) {
        warnings.push({
          code: 'same-place',
          message: `${nameOf(i - 1)} and ${nameOf(i)} are ${km.toFixed(2)} km apart`,
          path: ['stops', i],
          fix: `Merge ${nameOf(i - 1)} and ${nameOf(i)} into one stop and set its pause to the overnight time in seconds.`,
        })
      }
    }

    const seconds = legSeconds(
      route.legs.map((leg) => leg.length),
      timing.travel,
    )
    seconds.forEach((s, i) => {
      if (s < MIN_LEG_SECONDS) {
        warnings.push({
          code: 'short-leg',
          message: `${legName(i)} lasts ${+s.toFixed(2)} s`,
          path: ['legs', i],
          fix: `Raise timing.travel with update_project sceneSet, or merge ${nameOf(i)} and ${nameOf(i + 1)} into one stop.`,
        })
      }
    })

    const max = THEME_MAX_ZOOM[look.theme]
    const resolved = resolveShots(scene, aspect, route)
    const fitted: ('start' | 'end')[] = []
    // Follow doesn't use the start and end shots' zooms.
    for (const which of camera.mode === 'follow' ? [] : (['start', 'end'] as const)) {
      const zoom = resolved[which].zoom
      if (zoom <= max) continue
      if (camera[which]) {
        warnings.push({
          code: 'zoom-above-max',
          message: `The ${look.theme} theme's tiles stop at zoom ${max}, but the camera's ${which} view is at zoom ${zoomText(zoom)}`,
          path: ['camera', which, 'zoom'],
          fix: `With update_project sceneSet, set camera.${which}.zoom to ${max} or less, or set look.theme to 'blank' if you need the deeper zoom.`,
        })
      } else {
        fitted.push(which)
      }
    }
    if (fitted.length > 0) {
      // A default start is capped at the theme's maximum unless it's a fixed camera's whole-route fit, which is the
      // end shot too. So every fitted shot listed here has the same zoom.
      const zoom = zoomText(resolved[fitted[0]!].zoom)
      const views = `${fitted.join(' and ')} ${fitted.length > 1 ? 'views are' : 'view is'} at zoom ${zoom}`
      const resolvedName = (w: 'start' | 'end') => `scenes[${index}].camera.resolved${w === 'start' ? 'Start' : 'End'}`
      warnings.push({
        code: 'zoom-above-max',
        message: `The ${look.theme} theme's tiles stop at zoom ${max}, but the fitted ${views}`,
        path: ['camera'],
        fix:
          `With update_project sceneSet, store ${fitted.map((w) => `camera.${w}`).join(' and ')} with a zoom of ${max} or less, or set look.theme to 'blank' if you need the deeper zoom. ` +
          `get_project shows the fitted ${fitted.length > 1 ? 'shots' : 'shot'} as ${fitted.map(resolvedName).join(' and ')}; start from ${fitted.length > 1 ? 'those' : 'that'}.`,
      })
    }
  }

  const followZoom = camera.mode === 'follow' ? camera.follow?.zoom : undefined
  if (followZoom !== undefined && followZoom > THEME_MAX_ZOOM[look.theme]) {
    const max = THEME_MAX_ZOOM[look.theme]
    warnings.push({
      code: 'zoom-above-max',
      message: `The ${look.theme} theme's tiles stop at zoom ${max}, but the follow camera is at zoom ${zoomText(followZoom)}`,
      path: ['camera', 'follow', 'zoom'],
      fix: `With update_project sceneSet, set camera.follow.zoom to ${max} or less, or set look.theme to 'blank' if you need the deeper zoom.`,
    })
  }

  if (stops.length >= 2) {
    const route = buildRoute(scene, seaPaths)
    if (seaPaths) {
      route.legs.forEach((leg, i) => {
        if (leg.sea?.status === 'fallback') {
          warnings.push({
            code: 'sea-fallback',
            message: `${legName(i)} has no sea route: ${leg.sea.reason ?? 'routing failed'}`,
            path: ['legs', i, 'mode'],
            fix:
              leg.sea.reason === NO_LAND_DATA
                ? 'Reinstall Mapper, or run npm run build:land in its folder, then reopen the project. The leg is drawn as a straight line until then.'
                : "Add via points over open water with insert_via to guide it, move the stop nearer the coast, or set the leg's mode to 'line' with update_leg. It is drawn as a straight line until then.",
          })
        }
      })
      route.legs.forEach((leg, i) => {
        const land = leg.sea?.crossesLand
        if (land) {
          warnings.push({
            code: 'sea-crosses-land',
            message: `${legName(i)}'s sea route crosses land near [${land[0].toFixed(4)}, ${land[1].toFixed(4)}]`,
            path: ['legs', i, 'via'],
            fix: 'Move or add via points with update_via or insert_via so the route stays over water; a via point on land pulls the route ashore.',
          })
        }
      })
    }
    warnings.push(...signOverlaps(scene, aspect, fps, route, nameOf))
  }

  return { errors, warnings }
}
