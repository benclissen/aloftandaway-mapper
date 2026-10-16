import { describe, expect, test } from 'vitest'
import {
  MAP_CREDIT,
  SATELLITE_CREDIT,
  SATELLITE_CREDIT_WRITTEN,
  TERRAIN_CREDIT,
  TERRAIN_CREDIT_WRITTEN,
  projectCredit,
  sceneCredit,
  usesElevation,
} from '../../src/core/index.js'
import { emptyProject, sceneOf } from '../fixtures/projects.js'

function sceneWith(look: { theme?: string; terrain?: boolean }) {
  const scene = structuredClone(sceneOf(emptyProject()))
  Object.assign(scene.look, look)
  return scene
}

const LICENSED = 'Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0'

describe('map credit per scene', () => {
  test('the burned satellite line carries the licence', () => {
    expect(SATELLITE_CREDIT).toBe(LICENSED)
  })

  test('credit for paper', () => {
    expect(sceneCredit(sceneWith({ theme: 'paper', terrain: false }))).toEqual([MAP_CREDIT])
  })

  test('credit for satellite with terrain', () => {
    expect(sceneCredit(sceneWith({ theme: 'satellite', terrain: true }))).toEqual([MAP_CREDIT, SATELLITE_CREDIT, TERRAIN_CREDIT])
    expect(SATELLITE_CREDIT).toBe(LICENSED)
  })

  test('blank has no credit', () => {
    expect(sceneCredit(sceneWith({ theme: 'blank', terrain: false }))).toEqual([])
    expect(sceneCredit(sceneWith({ theme: 'blank', terrain: true }))).toEqual([TERRAIN_CREDIT])
  })

  test('outdoor shades hills from elevation data, so it credits terrain even with terrain off', () => {
    expect(usesElevation({ theme: 'outdoor', terrain: false })).toBe(true)
    expect(usesElevation({ theme: 'paper', terrain: false })).toBe(false)
    expect(sceneCredit(sceneWith({ theme: 'outdoor', terrain: false }))).toEqual([MAP_CREDIT, TERRAIN_CREDIT])
    expect(sceneCredit(sceneWith({ theme: 'outdoor', terrain: false }), 'written')).toEqual([MAP_CREDIT, TERRAIN_CREDIT_WRITTEN])
  })

  test('projectCredit dedupes across scenes', () => {
    const project = emptyProject()
    const [first] = project.scenes
    const paper = { ...structuredClone(first), id: 'b', look: { ...first.look, theme: 'paper' as const, terrain: false } }
    const sat = { ...structuredClone(first), id: 'c', look: { ...first.look, theme: 'satellite' as const, terrain: true } }
    project.scenes = [paper, sat, structuredClone(paper)]
    expect(projectCredit(project)).toEqual([MAP_CREDIT, SATELLITE_CREDIT, TERRAIN_CREDIT])
  })

  test('the written form carries the full satellite and terrain attribution', () => {
    const scene = sceneWith({ theme: 'satellite', terrain: true })
    expect(sceneCredit(scene, 'written')).toEqual([MAP_CREDIT, SATELLITE_CREDIT_WRITTEN, TERRAIN_CREDIT_WRITTEN])
    expect(sceneCredit(scene)).toEqual(sceneCredit(scene, 'burned'))
    expect(SATELLITE_CREDIT_WRITTEN).toContain('https://cloudless.eox.at')
    expect(SATELLITE_CREDIT_WRITTEN).toContain('CC BY 4.0')
    expect(SATELLITE_CREDIT_WRITTEN).toContain('Contains modified Copernicus Sentinel data 2016')
    for (const dataset of ['ArcticDEM', 'Geoscience Australia', 'Kartverket', 'EU-DEM', 'ETOPO1', 'INEGI', 'GMTED2010']) {
      expect(TERRAIN_CREDIT_WRITTEN).toContain(dataset)
    }
    expect(TERRAIN_CREDIT_WRITTEN).not.toContain('Mapzen')
  })

  test('the burned terrain credit is the short one, and blank without terrain still needs none', () => {
    expect(TERRAIN_CREDIT.length).toBeLessThan(80)
    expect(sceneCredit(sceneWith({ theme: 'blank', terrain: false }), 'written')).toEqual([])
    expect(sceneCredit(sceneWith({ theme: 'paper', terrain: false }), 'written')).toEqual([MAP_CREDIT])
  })

  test('projectCredit takes the form and dedupes within it', () => {
    const project = emptyProject()
    const [first] = project.scenes
    const sat = { ...structuredClone(first), id: 'c', look: { ...first.look, theme: 'satellite' as const, terrain: true } }
    project.scenes = [sat, structuredClone(sat)]
    expect(projectCredit(project, 'written')).toEqual([MAP_CREDIT, SATELLITE_CREDIT_WRITTEN, TERRAIN_CREDIT_WRITTEN])
  })
})
