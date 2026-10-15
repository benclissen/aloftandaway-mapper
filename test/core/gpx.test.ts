import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GpxError, haversineKm, importGpx, parseGpx, gpxToStops, type LngLat } from '../../src/core/index.js'
import { emptyProject, sceneOf } from '../fixtures/projects.js'

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/gpx/${name}`, import.meta.url), 'utf8')

function dense(n: number): string {
  const pts = Array.from({ length: n }, (_, i) => {
    const lon = 10 + (i / (n - 1)) * 0.5
    const lat = 45 + 0.05 * Math.sin((i / (n - 1)) * Math.PI * 6)
    return `<trkpt lat="${lat}" lon="${lon}"/>`
  })
  return `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Wave</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`
}

describe('gpx', () => {
  it('reads tracks, routes and named waypoints', () => {
    const t = parseGpx(fixture('track.gpx'))
    expect(t.lines).toHaveLength(1)
    expect(t.lines[0]).toMatchObject({ kind: 'track', name: 'Coastal Walk' })
    expect(t.lines[0]!.points[0]).toEqual([-5.7, 50.1])
    expect(t.waypoints.map((w) => w.name)).toEqual(['Harbour', 'Old Quay', 'Lighthouse', 'Inland Farm'])
    expect(t.waypoints[0]!.at).toEqual([-5.48, 50.101])
    const r = parseGpx(fixture('routes.gpx'))
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toMatchObject({ kind: 'route', name: 'Ridge Route' })
    expect(r.lines[0]!.points).toHaveLength(4)
  })

  it('reads a GPX 1.0 file with extensions and several segments', () => {
    const g = parseGpx(fixture('gpx10.gpx'))
    expect(g.lines).toHaveLength(1)
    expect(g.lines[0]!.points).toEqual([[11, 47], [11.01, 47.01], [11.03, 47.02], [11.04, 47.03]])
  })

  it('decodes character references in names but leaves CDATA as written', () => {
    const g = parseGpx(fixture('entities.gpx'))
    expect(g.waypoints.map((w) => w.name)).toEqual([
      "Côte d'Azur & Nice",
      'Cannes & Co &amp; more',
      '<Antibes> "Old Port" \u2014 &unknown; &#1114112;',
    ])
    expect(g.lines[0]!.name).toBe('Day 1 & 2')
    expect(gpxToStops(g, { track: 'Day 1 & 2', stops: 'ends' }).line?.name).toBe('Day 1 & 2')
  })

  it('skips points with an empty latitude or longitude', () => {
    const g = parseGpx(fixture('entities.gpx'))
    expect(g.lines[0]!.points).toEqual([
      [7.26, 43.7],
      [7.0, 43.5],
    ])
  })

  it('joins track segments in order', () => {
    const pts = parseGpx(fixture('track.gpx')).lines[0]!.points
    expect(pts).toHaveLength(12)
    expect(pts[5]).toEqual([-5.6, 50.102])
    expect(pts[6]).toEqual([-5.58, 50.1])
    expect(pts[11]).toEqual([-5.48, 50.1])
  })

  it('picks a track by index or name, and lists the names for an unknown one', () => {
    const g = parseGpx(fixture('multi.gpx'))
    expect(gpxToStops(g, { stops: 'ends' }).line?.name).toBe('Morning Loop')
    expect(gpxToStops(g, { track: 2, stops: 'ends' }).line?.name).toBe('Evening Climb')
    expect(gpxToStops(g, { track: 'Evening Climb', stops: 'ends' }).stops[0]!.at).toEqual([-3.6, 40.1])
    for (const bad of [3, 'Nope']) {
      try {
        gpxToStops(g, { track: bad, stops: 'ends' })
        expect.unreachable()
      } catch (e) {
        expect(e).toBeInstanceOf(GpxError)
        const err = e as GpxError
        expect(err.message).toContain('Morning Loop')
        expect(err.message).toContain('Evening Climb')
        expect(err.message).toContain('2')
      }
    }
  })

  it('ends mode makes two stops named after nearby waypoints', () => {
    const out = gpxToStops(parseGpx(fixture('track.gpx')), { stops: 'ends' })
    expect(out.stops.map((s) => s.name)).toEqual(['Coastal Walk start', 'Harbour'])
    expect(out.stops[0]!.at).toEqual([-5.7, 50.1])
    expect(out.via).toHaveLength(1)
    expect(out.line).toEqual({ kind: 'track', name: 'Coastal Walk' })
    const unnamed = gpxToStops(parseGpx(fixture('multi.gpx')), { track: 1, stops: 'ends' })
    expect(unnamed.stops.map((s) => s.name)).toEqual(['Morning Loop start', 'Morning Loop end'])
  })

  it('waypoints mode orders stops along the line and skips far waypoints', () => {
    const out = gpxToStops(parseGpx(fixture('track.gpx')), { stops: 'waypoints' })
    expect(out.stops.map((s) => s.name)).toEqual(['Old Quay', 'Lighthouse', 'Harbour'])
    expect(out.skipped).toHaveLength(1)
    expect(out.skipped[0]!.name).toBe('Inland Farm')
    expect(out.skipped[0]!.km).toBeGreaterThan(9)
    expect(out.skipped[0]!.km).toBeLessThan(11)
    expect(out.skipped[0]!.km).toBe(Math.round(out.skipped[0]!.km * 10) / 10)
    expect(out.via).toHaveLength(2)
    expect(out.via[0]!.length).toBeGreaterThan(0)
    expect(out.via[0]!.every((v) => v.sharp === undefined)).toBe(true)
  })

  it('caps via points at 100 per leg and keeps the shape', () => {
    const out = gpxToStops(parseGpx(dense(2000)), { stops: 'ends' })
    const via = out.via[0]!
    expect(via.length).toBeLessThanOrEqual(100)
    expect(via.length).toBeGreaterThan(10)
    const poly: LngLat[] = [out.stops[0]!.at, ...via.map((v) => v.at), out.stops[1]!.at]
    // every original point is near a kept vertex (the track is about 40 km wide)
    for (const p of parseGpx(dense(2000)).lines[0]!.points) {
      const d = Math.min(...poly.map((q) => haversineKm(p, q)))
      expect(d).toBeLessThan(4)
    }
  })

  it('waypoints-only file: waypoints mode uses file order, ends mode throws', () => {
    const g = parseGpx(fixture('waypoints-only.gpx'))
    const out = gpxToStops(g, { stops: 'waypoints' })
    expect(out.stops.map((s) => s.name)).toEqual(['Florence', 'Pisa', 'Genoa'])
    expect(out.via).toEqual([[], []])
    expect(out.line).toBeUndefined()
    try {
      gpxToStops(g, { stops: 'ends' })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(GpxError)
      expect((e as GpxError).message).toBe('This GPX file has no track or route.')
      expect((e as GpxError).fix).toBe("Pass stops: 'waypoints', or choose a file with a track.")
    }
  })

  it("rejects text that isn't GPX", () => {
    expect(() => parseGpx('<html><body>hi</body></html>')).toThrow(GpxError)
    expect(() => parseGpx('not xml at all')).toThrow(GpxError)
  })

  it('importGpx replaces the stops and sets via points and legMode', () => {
    const out = gpxToStops(parseGpx(fixture('track.gpx')), { stops: 'waypoints' })
    const project = importGpx(emptyProject(), out, { legMode: 'land', symbol: 'car' })
    const scene = sceneOf(project)
    expect(scene.stops.map((s) => s.name)).toEqual(['Old Quay', 'Lighthouse', 'Harbour'])
    expect(scene.legs).toHaveLength(2)
    expect(scene.legs.map((l) => l.mode)).toEqual(['land', 'land'])
    expect(scene.legs.map((l) => l.via)).toEqual(out.via)
    expect(scene.legs[0]!.symbol).toBe('car')
    const plain = sceneOf(importGpx(project, out, {}))
    expect(plain.legs.map((l) => l.mode)).toEqual(['line', 'line'])
  })

  it('defaults to ends mode', () => {
    const out = gpxToStops(parseGpx(fixture('track.gpx')), {})
    expect(out.stops).toHaveLength(2)
    expect(out.stops.map((s) => s.name)).toEqual(['Coastal Walk start', 'Harbour'])
    expect(() => gpxToStops(parseGpx(fixture('waypoints-only.gpx')), {})).toThrow('This GPX file has no track or route.')
  })

  it('throws when fewer than 2 waypoints are near the line', () => {
    const g = parseGpx(fixture('track.gpx'))
    g.waypoints = g.waypoints.filter((w) => w.name === 'Harbour' || w.name === 'Inland Farm')
    try {
      gpxToStops(g, { stops: 'waypoints' })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(GpxError)
      expect((e as GpxError).fix).toBe("Use stops: 'ends', or add named waypoints along the track.")
    }
  })

  it('simplifies a very long recording without overflowing the stack', () => {
    const out = gpxToStops(parseGpx(dense(200_000)), { stops: 'ends' })
    expect(out.via[0]!.length).toBeLessThanOrEqual(100)
  })
})
