import { defaultProject, type LngLat, type Project, type Scene, type Stop } from '../../src/core/index.js'

const ID = '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const NOW = '2026-10-13T10:00:00.000Z'

function stop(id: string, name: string, at: LngLat, extra: Partial<Stop> = {}): Stop {
  return { id, name, at, pause: 0, sign: 'always', ...extra }
}

/** The project's first scene, which every fixture's content lives in. */
export function sceneOf(p: Project): Scene {
  return p.scenes[0]!
}

function lineProject(name: string, stops: Stop[], overrides: Partial<Scene>): Project {
  const base = defaultProject({ id: ID, name, now: NOW, output: { height: 1080 } })
  const scene: Scene = {
    ...sceneOf(base),
    timing: { holdStart: 1, travel: 10, holdEnd: 2 },
    look: {
      theme: 'blank',
      labels: 'en',
      terrain: false,
      line: { color: '#d9472b', width: 4, dash: 'solid', outline: true, glow: false },
      symbol: 'dot',
      signStyle: 'tag',
    },
    stops,
    legs: stops.slice(1).map(() => ({ mode: 'line' as const, via: [] })),
    ...overrides,
  }
  return { ...base, scenes: [scene] }
}

export function greekIslands(scene: Partial<Scene> = {}): Project {
  return lineProject(
    'Greek Islands',
    [
      stop('piraeus', 'Piraeus', [23.6466, 37.942], { terminal: true }),
      stop('mykonos', 'Mykonos', [25.3289, 37.4467]),
      stop('santorini', 'Santorini', [25.4317, 36.4166], { pause: 1 }),
      stop('rhodes', 'Rhodes', [28.2278, 36.451], { terminal: true }),
    ],
    scene,
  )
}

/** The Greek Islands stops with every leg by sea, on the blank theme. */
export function cruise(): Project {
  const project = greekIslands()
  const scene = sceneOf(project)
  scene.legs = scene.legs.map((leg) => ({ ...leg, mode: 'sea' as const }))
  return project
}

export function pacific(): Project {
  return lineProject(
    'Pacific',
    [stop('suva', 'Suva', [178.4419, -18.1416]), stop('apia', 'Apia', [-171.7513, -13.8333])],
    {},
  )
}

export function stopsAt(points: LngLat[], scene: Partial<Scene> = {}): Project {
  return lineProject(
    'Stops',
    points.map((at, i) => stop(`s${i}`, `S${i}`, at)),
    scene,
  )
}

export function emptyProject(): Project {
  return defaultProject({ id: ID, name: 'Empty', now: NOW })
}
