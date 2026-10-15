// Rewrites the generated block of src/studio/stage/icons.ts from the pinned `lucide-static` package
// (ISC, see data/LICENSES/Lucide-ISC.txt). Lucide's <circle>, <rect>, <line> and <polyline> become path
// data. The hand-drawn section of icons.ts is left alone. The package is only read as data.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Which way each Lucide drawing points, checked by eye on the sheet in the Task 6 report. */
const LUCIDE: Record<string, 'right' | 'front' | 'north-east' | 'up'> = {
  footprints: 'up',
  bike: 'right',
  motorbike: 'right',
  scooter: 'right',
  car: 'right',
  bus: 'right',
  'train-front': 'front',
  'tram-front': 'front',
  'cable-car': 'front',
  ship: 'front',
  sailboat: 'right',
  kayak: 'north-east',
  plane: 'north-east',
  helicopter: 'right',
}

type Node = [string, Record<string, string | number>]

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(root, 'src/studio/stage/icons.ts')
const BEGIN = '// BEGIN GENERATED (npm run build:icons)'
const END = '// END GENERATED'

const n = (v: number): string => String(Math.round(v * 1000) / 1000)

function toPath([tag, a]: Node): string {
  const num = (k: string, fallback = 0) => (a[k] === undefined ? fallback : Number(a[k]))
  switch (tag) {
    case 'path':
      return String(a.d)
    case 'circle': {
      const [cx, cy, r] = [num('cx'), num('cy'), num('r')]
      return `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`
    }
    case 'rect': {
      const [x, y, w, h] = [num('x'), num('y'), num('width'), num('height')]
      const r = Math.min(num('rx', num('ry')), w / 2, h / 2)
      if (r === 0) return `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`
      const arc = `a${n(r)} ${n(r)} 0 0 1`
      return (
        `M${n(x + r)} ${n(y)}h${n(w - 2 * r)}${arc} ${n(r)} ${n(r)}v${n(h - 2 * r)}${arc} ${n(-r)} ${n(r)}` +
        `h${n(2 * r - w)}${arc} ${n(-r)} ${n(-r)}v${n(2 * r - h)}${arc} ${n(r)} ${n(-r)}Z`
      )
    }
    case 'line':
      return `M${n(num('x1'))} ${n(num('y1'))}L${n(num('x2'))} ${n(num('y2'))}`
    case 'polyline':
    case 'polygon': {
      const pts = String(a.points).trim().split(/[\s,]+/).map(Number)
      let d = `M${n(pts[0]!)} ${n(pts[1]!)}`
      for (let i = 2; i < pts.length; i += 2) d += `L${n(pts[i]!)} ${n(pts[i + 1]!)}`
      return tag === 'polygon' ? `${d}Z` : d
    }
    default:
      throw new Error(`unsupported SVG element <${tag}>`)
  }
}

const nodes = JSON.parse(await fs.readFile(path.join(root, 'node_modules/lucide-static/icon-nodes.json'), 'utf8')) as Record<
  string,
  Node[]
>

const lines: string[] = []
for (const [name, facing] of Object.entries(LUCIDE)) {
  const icon = nodes[name]
  if (!icon) throw new Error(`lucide-static has no icon called ${name}`)
  const key = /^[a-z]+$/.test(name) ? name : `'${name}'`
  lines.push(`  ${key}: {`, `    facing: '${facing}',`, '    paths: [')
  for (const node of icon) lines.push(`      ${JSON.stringify(toPath(node))},`)
  lines.push('    ],', '  },')
}

const source = await fs.readFile(FILE, 'utf8')
const from = source.indexOf(BEGIN)
const to = source.indexOf(END)
if (from < 0 || to < 0) throw new Error(`${FILE} is missing its generated markers`)
const block = `${BEGIN}\nconst LUCIDE_ICONS = {\n${lines.join('\n')}\n} satisfies Record<string, IconDef>\n`
await fs.writeFile(FILE, source.slice(0, from) + block + source.slice(to))
console.log(`wrote ${Object.keys(LUCIDE).length} Lucide icons to ${path.relative(root, FILE)}`)
