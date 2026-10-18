import { cameraAt, projectToLayout, resolveShots } from './camera.js'
import { haversineKm } from './geo.js'
import { buildContextRoute, buildRoute } from './route.js'
import { fpsValue, THEME_MAX_ZOOM, type Aspect, type Fps, type Project, type Scene } from './schema.js'
import { NO_LAND_DATA, STOP_FAR_KM, STRAIGHT_LINE, UNVERIFIED_CAUSE, type SeaPaths } from './sea.js'
import { SAME_PLACE_KM, TRACK_NEAR_KM } from './track.js'
import { signBox, signLift, signText } from './signs.js'
import { buildTimeline, formatTimecode, legSeconds, sceneTravel, SIGN_FADE_SECONDS } from './timeline.js'

export interface Issue {
  code: string
  message: string
  path?: (string | number)[]
  fix?: string
}

/** A leg that lasts less than this many seconds is a warning. */
const MIN_LEG_SECONDS = 1

/**
 * Checks a project for what blocks a render (errors) and what an agent should fix or explain (warnings). Every scene
 * is checked. Every issue carries a `path` into the project, starting `['scenes', i]`, and a `fix` sentence for the
 * agent. Sea legs are measured along their paths in `opts.seaPaths`, and as lines where they have none. Track legs
 * follow their tracks in `opts.seaPaths` too; the sea and track checks run only when it's passed.
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

/** Seconds for a message, to 2 decimals and trimmed. */
const secondsText = (s: number): string => String(+s.toFixed(2))

/** A zoom for a message, rounded up to 2 decimals and trimmed, so a value over the maximum never reads as the maximum. */
const zoomText = (zoom: number): string => String(Math.ceil(zoom * 100 - 1e-9) / 100)

/** What to do about each reason a sea path is unverified. */
const UNVERIFIED_FIX = {
  offline: 'Reconnect to the internet; Mapper routes the leg again by itself within a minute. Then validate again.',
  budget: 'Validate again in a minute; Mapper carries on where it stopped.',
  unsettled: 'Add a via point over open water with insert_via to steer it.',
} as const

/**
 * What to do about a sea leg that fell back. One the network or the budget left unverified is routed again by itself
 * once the tiles can be had, so it only needs waiting for, not an edit.
 */
function fallbackFix(sea: { reason?: string; unverified?: keyof typeof UNVERIFIED_FIX }, context = false): string {
  if (sea.reason === NO_LAND_DATA) {
    return 'Reinstall Mapper, or run npm run build:land in its folder, then reopen the project. The leg is drawn as a straight line until then.'
  }
  if (sea.unverified === 'offline' || sea.unverified === 'budget') return `${UNVERIFIED_FIX[sea.unverified]} It is drawn as a straight line until then.`
  if (context) {
    return "Fix the leg in the scene it was copied from (add via points over open water, or set its mode to 'line'), then run copy_context again. It is drawn as a straight line until then."
  }
  return "Add via points over open water with insert_via to guide it, move the stop nearer the coast, or set the leg's mode to 'line' with update_leg. It is drawn as a straight line until then."
}

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
  /** The keys the camera follows: a glide's, or none. */
  const keys = camera.mode === 'glide' ? camera.keys : undefined

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
      // Two stops at one place with a recorded track between them are a loop, and merging them would lose its leg.
      if (km < SAME_PLACE_KM && route.legs[i - 1]?.drawnAs !== 'track') {
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
      sceneTravel(scene),
    )
    seconds.forEach((s, i) => {
      if (s < MIN_LEG_SECONDS) {
        warnings.push({
          code: 'short-leg',
          message: `${legName(i)} lasts ${+s.toFixed(2)} s`,
          path: ['legs', i],
          fix: `Raise ${timing.length === undefined ? 'timing.travel' : 'timing.length'} with update_project sceneSet, or merge ${nameOf(i)} and ${nameOf(i + 1)} into one stop.`,
        })
      }
    })

    const max = THEME_MAX_ZOOM[look.theme]
    const resolved = resolveShots(scene, aspect, route)
    const fitted: ('start' | 'end')[] = []
    // Follow doesn't use the start and end shots' zooms, and a keyed glide checks its keys instead.
    for (const which of camera.mode === 'follow' || keys ? [] : (['start', 'end'] as const)) {
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

    if (keys) {
      keys.forEach((key, k) => {
        if (key.shot.zoom <= max) return
        warnings.push({
          code: 'zoom-above-max',
          message: `The ${look.theme} theme's tiles stop at zoom ${max}, but the camera key at ${secondsText(key.at)} s is at zoom ${zoomText(key.shot.zoom)}`,
          path: ['camera', 'keys', k, 'shot', 'zoom'],
          fix: `With update_project sceneSet, set camera.keys[${k}].shot.zoom to ${max} or less, sending the whole keys list, or set look.theme to 'blank' if you need the deeper zoom.`,
        })
      })
      const rate = fpsValue(fps)
      const lastFrame = buildTimeline(scene, fps, route).totalFrames - 1
      keys.forEach((key, k) => {
        if (key.at * rate <= lastFrame + 1e-9) return
        warnings.push({
          code: 'camera-key-late',
          message: `The camera key at ${secondsText(key.at)} s comes after the scene's last frame, at ${secondsText(lastFrame / rate)} s, so the camera never reaches it`,
          path: ['camera', 'keys', k, 'at'],
          fix: `With update_project sceneSet, move the key to ${secondsText(lastFrame / rate)} s or earlier, sending the whole keys list, or lengthen the scene with timing.travel or timing.holdEnd.`,
        })
      })
    }
  }

  if (keys) {
    keys.forEach((key, k) => {
      const prev = keys[k - 1]
      if (!prev || key.at > prev.at) return
      errors.push({
        code: 'camera-keys-order',
        message:
          key.at === prev.at
            ? `Camera keys ${k} and ${k + 1} are both at ${secondsText(key.at)} s`
            : `Camera key ${k + 1}, at ${secondsText(key.at)} s, comes before key ${k}, at ${secondsText(prev.at)} s`,
        path: ['camera', 'keys', k, 'at'],
        fix: 'With update_project sceneSet, send camera.keys in ascending order of at, with no two keys at the same time.',
      })
    })
    const stored = (['start', 'end'] as const).filter((w) => camera[w])
    if (stored.length > 0) {
      const names = stored.map((w) => `camera.${w}`).join(' and ')
      warnings.push({
        code: 'camera-start-end-ignored',
        message: `The glide camera follows its keys, so the stored ${stored.join(' and ')} ${stored.length > 1 ? 'shots are' : 'shot is'} ignored`,
        path: stored.length > 1 ? ['camera'] : ['camera', stored[0]!],
        fix: `With update_project sceneSet, set ${names} to null, or set camera.keys to null to glide from the stored ${stored.length > 1 ? 'shots' : 'shot'} instead.`,
      })
    }
  } else if (camera.keys) {
    warnings.push({
      code: 'camera-keys-ignored',
      message: `A ${camera.mode} camera ignores its keys; only a glide uses them`,
      path: ['camera', 'keys'],
      fix: "With update_project sceneSet, set camera.mode to 'glide' to use the keys, or set camera.keys to null to drop them.",
    })
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
            fix: fallbackFix(leg.sea),
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
      route.legs.forEach((leg, i) => {
        const why = leg.sea?.unverified
        if (!why) return
        warnings.push({
          code: 'sea-unverified',
          message:
            leg.sea?.status === 'fallback'
              ? `${legName(i)} has no checked sea route, because ${UNVERIFIED_CAUSE[why]}. It's ${STRAIGHT_LINE}.`
              : why === 'unsettled'
              ? `${legName(i)}'s sea route was only partly checked, because ${UNVERIFIED_CAUSE[why]}. It may cross small islands near the ones it found.`
              : `${legName(i)}'s sea route was checked against Natural Earth only, because ${UNVERIFIED_CAUSE[why]}. It may cross small islands.`,
          path: ['legs', i],
          fix: UNVERIFIED_FIX[why],
        })
      })
      // A stop can be the end of one sea leg and the start of the next: it is warned once, for the worse gap.
      const far = new Map<number, { km: number; end: 'starts' | 'ends' }>()
      route.legs.forEach((leg, i) => {
        const gaps = leg.sea?.status === 'ok' ? leg.sea.stopGapKm : undefined
        if (!gaps) return
        ;([[i, gaps[0], 'starts'], [i + 1, gaps[1], 'ends']] as const).forEach(([stop, km, end]) => {
          if (km > STOP_FAR_KM && km > (far.get(stop)?.km ?? 0)) far.set(stop, { km, end })
        })
      })
      for (const [stop, { km, end }] of [...far].sort((a, b) => a[0] - b[0])) {
        warnings.push({
          code: 'sea-stop-far',
          message: `${nameOf(stop)} is ${km.toFixed(1)} km from the water its sea route ${end} in, so the line crosses land to reach it.`,
          path: ['stops', stop],
          fix: 'Move the stop to the quay with update_stop, or add a via point at the harbour mouth with insert_via.',
        })
      }
      route.legs.forEach((leg, i) => {
        if (leg.track?.status !== 'missing') return
        const { id } = leg.track
        errors.push({
          code: 'track-missing',
          message: `${legName(i)} uses the recorded track ${id}, but tracks/${id}.json is missing or unreadable.`,
          path: ['legs', i],
          fix: 'Put the file back, or run import_track again.',
        })
      })
      // A stop can end one track leg and start the next: it is warned once, for the worse gap. Two legs on one track
      // share the cut there, so their gaps are equal, and the leg arriving at the stop is named.
      const offTrack = new Map<number, { km: number; leg: number }>()
      route.legs.forEach((leg, i) => {
        const gaps = leg.track?.stopGapKm
        if (!gaps) return
        ;([[i, gaps[0]], [i + 1, gaps[1]]] as const).forEach(([stop, km]) => {
          if (km > TRACK_NEAR_KM && km > (offTrack.get(stop)?.km ?? 0)) offTrack.set(stop, { km, leg: i })
        })
      })
      for (const [stop, { km, leg }] of [...offTrack].sort((a, b) => a[0] - b[0])) {
        warnings.push({
          code: 'track-stop-far',
          message: `${nameOf(stop)} is ${km.toFixed(1)} km from the recorded track of ${legName(leg)}, so the line jumps to it.`,
          path: ['stops', stop],
          fix: 'Move the stop onto the track, or check the stops are in travel order.',
        })
      }
    }
    warnings.push(...signOverlaps(scene, aspect, fps, route, nameOf))
  }

  const context = seaPaths && scene.context ? buildContextRoute(scene, seaPaths) : undefined
  if (scene.context && context) {
    const contextName = (i: number) => scene.context!.stops[i]?.name || `Stop ${i + 1}`
    context.legs.forEach((leg, i) => {
      if (leg.sea?.status !== 'fallback') return
      warnings.push({
        code: 'context-sea-fallback',
        message: `Context leg ${i + 1} (${contextName(i)} → ${contextName(i + 1)}) has no sea route: ${leg.sea.reason ?? 'routing failed'}`,
        path: ['context', 'legs', i, 'mode'],
        fix: fallbackFix(leg.sea, true),
      })
    })
  }

  return { errors, warnings }
}
