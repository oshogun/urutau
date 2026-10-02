import type { Label } from './types.ts'

/** Carbon `Tag` types that can stand in for an arbitrary label color. */
export type LabelTagType =
  | 'red'
  | 'magenta'
  | 'purple'
  | 'blue'
  | 'cyan'
  | 'teal'
  | 'green'
  | 'warm-gray'
  | 'gray'

/**
 * Approximate hue of each Carbon tag palette. Carbon has no orange or yellow
 * tag, so warm hues fall back to `warm-gray`.
 */
const REFERENCE_HUES: ReadonlyArray<readonly [LabelTagType, number]> = [
  ['red', 0],
  ['warm-gray', 45],
  ['green', 135],
  ['teal', 175],
  ['cyan', 200],
  ['blue', 220],
  ['purple', 265],
  ['magenta', 330],
]

/** Maps a GitHub label color (`rrggbb`) to the closest Carbon tag type. */
export function tagTypeForColor(hex: string): LabelTagType {
  const hsl = hexToHsl(hex)
  if (!hsl) return 'gray'
  const { h, s, l } = hsl
  if (s < 0.25 || l > 0.95 || l < 0.08) return 'gray'

  let best: LabelTagType = 'gray'
  let bestDistance = Infinity
  for (const [type, hue] of REFERENCE_HUES) {
    const raw = Math.abs(h - hue)
    const distance = Math.min(raw, 360 - raw)
    if (distance < bestDistance) {
      best = type
      bestDistance = distance
    }
  }
  return best
}

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const int = Number.parseInt(match[1], 16)
  const r = ((int >> 16) & 0xff) / 255
  const g = ((int >> 8) & 0xff) / 255
  const b = (int & 0xff) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const delta = max - min
  if (delta === 0) return { h: 0, s: 0, l }

  const s = delta / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / delta) % 6
  else if (max === g) h = (b - r) / delta + 2
  else h = (r - g) / delta + 4
  h = (h * 60 + 360) % 360
  return { h, s, l }
}

const FALLBACK_COLOR = 'c6c6c6'

/** Looks up a label by name, with a neutral stand-in for labels the repo no longer lists. */
export function labelFor(name: string, labelsByName: ReadonlyMap<string, Label>): Label {
  return labelsByName.get(name) ?? { name, color: FALLBACK_COLOR, description: null }
}
