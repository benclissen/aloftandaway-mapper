import { resolveShots } from './camera.js'
import { haversineKm } from './geo.js'
import { buildRoute } from './route.js'
import { THEME_MAX_ZOOM, type Aspect, type Project, type Scene } from './schema.js'
import type { SeaPaths } from './sea.js'
import { legSeconds } from './timeline.js'

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
    const found = validateScene(scene, project.output.aspect, opts.seaPaths)
    errors.push(...found.errors.map(prefix))
    warnings.push(...found.warnings.map(prefix))
  })
  return { errors, warnings }
}

/** Checks one scene. Issue paths are relative to the scene. */
function validateScene(
  scene: Scene,
  aspect: Aspect,
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
    for (const which of ['start', 'end'] as const) {
      const zoom = resolved[which].zoom
      if (zoom <= max) continue
      if (camera[which]) {
        warnings.push({
          code: 'zoom-above-max',
          message: `The ${look.theme} theme's tiles stop at zoom ${max}, but the camera's ${which} view is at zoom ${zoom.toFixed(1)}`,
          path: ['camera', which, 'zoom'],
          fix: `With update_project sceneSet, set camera.${which}.zoom to ${max} or less, or set look.theme to 'blank' if you need the deeper zoom.`,
        })
      } else {
        fitted.push(which)
      }
    }
    if (fitted.length > 0) {
      // Both fitted shots come from the same bounds, so they share a zoom.
      const zoom = resolved[fitted[0]!].zoom.toFixed(1)
      const which = fitted.join(' and ')
      warnings.push({
        code: 'zoom-above-max',
        message: `The ${look.theme} theme's tiles stop at zoom ${max}, but the fitted ${which} ${fitted.length > 1 ? 'views are' : 'view is'} at zoom ${zoom}`,
        path: ['camera'],
        fix:
          `With update_project sceneSet, store ${fitted.map((w) => `camera.${w}`).join(' and ')} with a zoom of ${max} or less, or set look.theme to 'blank' if you need the deeper zoom. ` +
          'get_project shows the fitted shots as scenes[0].camera.resolvedStart and scenes[0].camera.resolvedEnd; start from those.',
      })
    }
  }

  const followZoom = camera.mode === 'follow' ? camera.follow?.zoom : undefined
  if (followZoom !== undefined && followZoom > THEME_MAX_ZOOM[look.theme]) {
    const max = THEME_MAX_ZOOM[look.theme]
    warnings.push({
      code: 'zoom-above-max',
      message: `The ${look.theme} theme's tiles stop at zoom ${max}, but the follow camera is at zoom ${followZoom.toFixed(1)}`,
      path: ['camera', 'follow', 'zoom'],
      fix: `With update_project sceneSet, set camera.follow.zoom to ${max} or less, or set look.theme to 'blank' if you need the deeper zoom.`,
    })
  }

  if (look.terrain) {
    warnings.push({
      code: 'not-available-yet',
      message: "Terrain isn't available yet",
      path: ['look', 'terrain'],
      fix: "Set look.terrain to false with update_project sceneSet, because terrain isn't available yet.",
    })
  }

  if (look.symbol !== 'none' && look.symbol !== 'dot') {
    warnings.push({
      code: 'not-available-yet',
      message: `The '${look.symbol}' symbol isn't available yet`,
      path: ['look', 'symbol'],
      fix: "Set look.symbol to 'dot' or 'none' with update_project sceneSet; other symbols aren't available yet.",
    })
  }

  return { errors, warnings }
}
