import { Effect, Schema } from "effect"
import DESCRIPTION from "./color.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "parse",
  "to_hex",
  "to_rgb",
  "to_rgba",
  "to_hsl",
  "to_hsv",
  "lighten",
  "darken",
  "saturate",
  "desaturate",
  "alpha",
  "mix",
  "complement",
  "contrast",
  "luminance",
  "is_dark",
  "is_light",
  "random",
] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  value: Schema.optional(Schema.String).annotate({ description: "Color literal (hex/rgb/hsl/hsv/named)." }),
  a: Schema.optional(Schema.String).annotate({ description: "Color a (mix/contrast)." }),
  b: Schema.optional(Schema.String).annotate({ description: "Color b (mix/contrast)." }),
  amount: Schema.optional(Schema.Number).annotate({ description: "0..1 for lighten/darken/sat/desat/mix/alpha." }),
  seed: Schema.optional(Schema.String).annotate({ description: "Seed for `random` action (reproducible)." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  action: (typeof ACTIONS)[number]
  result?: unknown
}

type RGBA = { r: number; g: number; b: number; a: number }
type HSLA = { h: number; s: number; l: number; a: number }

// ---------- Named colors (CSS3) ----------
const NAMED: Record<string, string> = {
  aliceblue: "#f0f8ff", antiquewhite: "#faebd7", aqua: "#00ffff", aquamarine: "#7fffd4", azure: "#f0ffff",
  beige: "#f5f5dc", bisque: "#ffe4c4", black: "#000000", blanchedalmond: "#ffebcd", blue: "#0000ff",
  blueviolet: "#8a2be2", brown: "#a52a2a", burlywood: "#deb887", cadetblue: "#5f9ea0", chartreuse: "#7fff00",
  chocolate: "#d2691e", coral: "#ff7f50", cornflowerblue: "#6495ed", cornsilk: "#fff8dc", crimson: "#dc143c",
  cyan: "#00ffff", darkblue: "#00008b", darkcyan: "#008b8b", darkgoldenrod: "#b8860b", darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9", darkgreen: "#006400", darkkhaki: "#bdb76b", darkmagenta: "#8b008b", darkolivegreen: "#556b2f",
  darkorange: "#ff8c00", darkorchid: "#9932cc", darkred: "#8b0000", darksalmon: "#e9967a", darkseagreen: "#8fbc8f",
  darkslateblue: "#483d8b", darkslategray: "#2f4f4f", darkslategrey: "#2f4f4f", darkturquoise: "#00ced1",
  darkviolet: "#9400d3", deeppink: "#ff1493", deepskyblue: "#00bfff", dimgray: "#696969", dimgrey: "#696969",
  dodgerblue: "#1e90ff", firebrick: "#b22222", floralwhite: "#fffaf0", forestgreen: "#228b22", fuchsia: "#ff00ff",
  gainsboro: "#dcdcdc", ghostwhite: "#f8f8ff", gold: "#ffd700", goldenrod: "#daa520", gray: "#808080",
  grey: "#808080", green: "#008000", greenyellow: "#adff2f", honeydew: "#f0fff0", hotpink: "#ff69b4",
  indianred: "#cd5c5c", indigo: "#4b0082", ivory: "#fffff0", khaki: "#f0e68c", lavender: "#e6e6fa",
  lavenderblush: "#fff0f5", lawngreen: "#7cfc00", lemonchiffon: "#fffacd", lightblue: "#add8e6", lightcoral: "#f08080",
  lightcyan: "#e0ffff", lightgoldenrodyellow: "#fafad2", lightgray: "#d3d3d3", lightgrey: "#d3d3d3",
  lightgreen: "#90ee90", lightpink: "#ffb6c1", lightsalmon: "#ffa07a", lightseagreen: "#20b2aa",
  lightskyblue: "#87cefa", lightslategray: "#778899", lightslategrey: "#778899", lightsteelblue: "#b0c4de",
  lightyellow: "#ffffe0", lime: "#00ff00", limegreen: "#32cd32", linen: "#faf0e6", magenta: "#ff00ff",
  maroon: "#800000", mediumaquamarine: "#66cdaa", mediumblue: "#0000cd", mediumorchid: "#ba55d3",
  mediumpurple: "#9370db", mediumseagreen: "#3cb371", mediumslateblue: "#7b68ee", mediumspringgreen: "#00fa9a",
  mediumturquoise: "#48d1cc", mediumvioletred: "#c71585", midnightblue: "#191970", mintcream: "#f5fffa",
  mistyrose: "#ffe4e1", moccasin: "#ffe4b5", navajowhite: "#ffdead", navy: "#000080", oldlace: "#fdf5e6",
  olive: "#808000", olivedrab: "#6b8e23", orange: "#ffa500", orangered: "#ff4500", orchid: "#da70d6",
  palegoldenrod: "#eee8aa", palegreen: "#98fb98", paleturquoise: "#afeeee", palevioletred: "#db7093",
  papayawhip: "#ffefd5", peachpuff: "#ffdab9", peru: "#cd853f", pink: "#ffc0cb", plum: "#dda0dd",
  powderblue: "#b0e0e6", purple: "#800080", rebeccapurple: "#663399", red: "#ff0000", rosybrown: "#bc8f8f",
  royalblue: "#4169e1", saddlebrown: "#8b4513", salmon: "#fa8072", sandybrown: "#f4a460", seagreen: "#2e8b57",
  seashell: "#fff5ee", sienna: "#a0522d", silver: "#c0c0c0", skyblue: "#87ceeb", slateblue: "#6a5acd",
  slategray: "#708090", slategrey: "#708090", snow: "#fffafa", springgreen: "#00ff7f", steelblue: "#4682b4",
  tan: "#d2b48c", teal: "#008080", thistle: "#d8bfd8", tomato: "#ff6347", transparent: "#00000000",
  turquoise: "#40e0d0", violet: "#ee82ee", wheat: "#f5deb3", white: "#ffffff", whitesmoke: "#f5f5f5",
  yellow: "#ffff00", yellowgreen: "#9acd32",
}

const REVERSE_NAMED: Record<string, string> = {}
for (const [name, hex] of Object.entries(NAMED)) {
  if (!REVERSE_NAMED[hex]) REVERSE_NAMED[hex] = name
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}
function clamp01(n: number): number {
  return clamp(n, 0, 1)
}
function clamp255(n: number): number {
  return clamp(Math.round(n), 0, 255)
}

export function parseColor(input: string): RGBA {
  const s = input.trim().toLowerCase()
  // Named
  if (NAMED[s]) return parseColor(NAMED[s])
  // #RRGGBB / #RGB / #RRGGBBAA / #RGBA
  if (s.startsWith("#")) {
    let hex = s.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.split("").map((c) => c + c).join("")
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      }
    }
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      }
    }
    throw new Error(`color: invalid hex '${input}'`)
  }
  // rgb(a)
  let m = /^rgba?\s*\(\s*([0-9.]+%?)\s*[,\s]\s*([0-9.]+%?)\s*[,\s]\s*([0-9.]+%?)\s*(?:[,\s/]\s*([0-9.]+%?))?\s*\)$/.exec(s)
  if (m) {
    const r = parseChannel255(m[1]!)
    const g = parseChannel255(m[2]!)
    const b = parseChannel255(m[3]!)
    const a = m[4] ? parseAlpha(m[4]!) : 1
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: clamp01(a) }
  }
  // hsl(a)
  m = /^hsla?\s*\(\s*([0-9.-]+)(?:deg)?\s*[,\s]\s*([0-9.]+)%?\s*[,\s]\s*([0-9.]+)%?\s*(?:[,\s/]\s*([0-9.]+%?))?\s*\)$/.exec(s)
  if (m) {
    const h = parseFloat(m[1]!)
    const sat = parseFloat(m[2]!) / 100
    const l = parseFloat(m[3]!) / 100
    const a = m[4] ? parseAlpha(m[4]!) : 1
    return hslToRgb({ h, s: sat, l, a })
  }
  // hsv
  m = /^hsva?\s*\(\s*([0-9.-]+)(?:deg)?\s*[,\s]\s*([0-9.]+)%?\s*[,\s]\s*([0-9.]+)%?\s*(?:[,\s/]\s*([0-9.]+%?))?\s*\)$/.exec(s)
  if (m) {
    const h = parseFloat(m[1]!)
    const sat = parseFloat(m[2]!) / 100
    const v = parseFloat(m[3]!) / 100
    const a = m[4] ? parseAlpha(m[4]!) : 1
    return hsvToRgb(h, sat, v, a)
  }
  throw new Error(`color: cannot parse '${input}'`)
}

function parseChannel255(s: string): number {
  if (s.endsWith("%")) return (parseFloat(s) * 255) / 100
  return parseFloat(s)
}
function parseAlpha(s: string): number {
  if (s.endsWith("%")) return parseFloat(s) / 100
  return parseFloat(s)
}

export function rgbToHsl(c: RGBA): HSLA {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0))
    else if (max === g) h = ((b - r) / d + 2)
    else h = ((r - g) / d + 4)
    h *= 60
  }
  return { h, s, l, a: c.a }
}

export function hslToRgb(c: HSLA): RGBA {
  const { h, s, l, a } = c
  const hue = ((h % 360) + 360) % 360
  const c2 = (1 - Math.abs(2 * l - 1)) * s
  const x = c2 * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - c2 / 2
  let r1 = 0, g1 = 0, b1 = 0
  if (hue < 60) { r1 = c2; g1 = x }
  else if (hue < 120) { r1 = x; g1 = c2 }
  else if (hue < 180) { g1 = c2; b1 = x }
  else if (hue < 240) { g1 = x; b1 = c2 }
  else if (hue < 300) { r1 = x; b1 = c2 }
  else { r1 = c2; b1 = x }
  return { r: clamp255((r1 + m) * 255), g: clamp255((g1 + m) * 255), b: clamp255((b1 + m) * 255), a }
}

export function hsvToRgb(h: number, s: number, v: number, a = 1): RGBA {
  const hue = ((h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = v - c
  let r1 = 0, g1 = 0, b1 = 0
  if (hue < 60) { r1 = c; g1 = x }
  else if (hue < 120) { r1 = x; g1 = c }
  else if (hue < 180) { g1 = c; b1 = x }
  else if (hue < 240) { g1 = x; b1 = c }
  else if (hue < 300) { r1 = x; b1 = c }
  else { r1 = c; b1 = x }
  return { r: clamp255((r1 + m) * 255), g: clamp255((g1 + m) * 255), b: clamp255((b1 + m) * 255), a }
}

function rgbToHsv(c: RGBA): { h: number; s: number; v: number; a: number } {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0
  const v = max
  const d = max - min
  const s = max === 0 ? 0 : d / max
  if (max !== min) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0))
    else if (max === g) h = ((b - r) / d + 2)
    else h = ((r - g) / d + 4)
    h *= 60
  }
  return { h, s, v, a: c.a }
}

function toHexCh(n: number): string {
  return clamp255(n).toString(16).padStart(2, "0").toUpperCase()
}

export function toHex(c: RGBA): string {
  const base = `#${toHexCh(c.r)}${toHexCh(c.g)}${toHexCh(c.b)}`
  if (c.a < 1) return base + toHexCh(c.a * 255)
  return base
}

export function toRgb(c: RGBA): string {
  return `rgb(${clamp255(c.r)}, ${clamp255(c.g)}, ${clamp255(c.b)})`
}
export function toRgba(c: RGBA): string {
  return `rgba(${clamp255(c.r)}, ${clamp255(c.g)}, ${clamp255(c.b)}, ${c.a.toFixed(3)})`
}
export function toHsl(c: RGBA): string {
  const h = rgbToHsl(c)
  if (h.a < 1) {
    return `hsla(${Math.round(h.h)}, ${Math.round(h.s * 100)}%, ${Math.round(h.l * 100)}%, ${h.a.toFixed(3)})`
  }
  return `hsl(${Math.round(h.h)}, ${Math.round(h.s * 100)}%, ${Math.round(h.l * 100)}%)`
}

export function relativeLuminance(c: RGBA): number {
  const ch = (n: number) => {
    const x = n / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}

export function contrastRatio(a: RGBA, b: RGBA): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

function hashSeed(s: string): () => number {
  // xfnv1a-ish then mulberry32
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  let a = h
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0
    t ^= t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const ColorTool = Tool.define(
  "color",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action

          if (action === "random") {
            const rand = params.seed ? hashSeed(params.seed) : Math.random
            const c: RGBA = {
              r: Math.floor(rand() * 256),
              g: Math.floor(rand() * 256),
              b: Math.floor(rand() * 256),
              a: 1,
            }
            const hex = toHex(c)
            return done({
              title: `color.random: ${hex}`,
              metadata: { action, result: hex },
              output: hex,
            })
          }

          // All other actions need at least value (or a/b)
          const needValue = !["mix", "contrast"].includes(action)
          if (needValue && !params.value) throw new Error(`color.${action}: requires \`value\``)

          if (action === "parse") {
            const c = parseColor(params.value!)
            const hsl = rgbToHsl(c)
            const hsv = rgbToHsv(c)
            const hex = toHex(c)
            const named = REVERSE_NAMED[hex.toLowerCase()]
            const result = {
              hex,
              rgb: toRgb(c),
              rgba: toRgba(c),
              hsl: toHsl({ ...c }),
              hsla: { h: hsl.h, s: hsl.s, l: hsl.l, a: hsl.a },
              hsv: { h: hsv.h, s: hsv.s, v: hsv.v, a: hsv.a },
              named: named ?? null,
              luminance: relativeLuminance(c),
              alpha: c.a,
              channels: { r: c.r, g: c.g, b: c.b, a: c.a },
            }
            return done({
              title: `color.parse: ${hex}`,
              metadata: { action, result },
              output: JSON.stringify(result, null, 2),
            })
          }

          if (action === "to_hex") {
            const r = toHex(parseColor(params.value!))
            return done({ title: `color.to_hex: ${r}`, metadata: { action, result: r }, output: r })
          }
          if (action === "to_rgb") {
            const r = toRgb(parseColor(params.value!))
            return done({ title: `color.to_rgb: ${r}`, metadata: { action, result: r }, output: r })
          }
          if (action === "to_rgba") {
            const r = toRgba(parseColor(params.value!))
            return done({ title: `color.to_rgba: ${r}`, metadata: { action, result: r }, output: r })
          }
          if (action === "to_hsl") {
            const r = toHsl(parseColor(params.value!))
            return done({ title: `color.to_hsl: ${r}`, metadata: { action, result: r }, output: r })
          }
          if (action === "to_hsv") {
            const c = parseColor(params.value!)
            const h = rgbToHsv(c)
            const r = { h: Math.round(h.h), s: +(h.s * 100).toFixed(1), v: +(h.v * 100).toFixed(1), a: h.a }
            return done({
              title: `color.to_hsv: ${JSON.stringify(r)}`,
              metadata: { action, result: r },
              output: JSON.stringify(r),
            })
          }

          if (action === "lighten" || action === "darken") {
            const c = parseColor(params.value!)
            const amt = params.amount ?? 0.1
            const h = rgbToHsl(c)
            h.l = clamp01(h.l + (action === "lighten" ? amt : -amt))
            const out = toHex(hslToRgb(h))
            return done({ title: `color.${action}: ${out}`, metadata: { action, result: out }, output: out })
          }

          if (action === "saturate" || action === "desaturate") {
            const c = parseColor(params.value!)
            const amt = params.amount ?? 0.1
            const h = rgbToHsl(c)
            h.s = clamp01(h.s + (action === "saturate" ? amt : -amt))
            const out = toHex(hslToRgb(h))
            return done({ title: `color.${action}: ${out}`, metadata: { action, result: out }, output: out })
          }

          if (action === "alpha") {
            const c = parseColor(params.value!)
            const amt = params.amount ?? 1
            c.a = clamp01(amt)
            const out = c.a < 1 ? toRgba(c) : toHex(c)
            return done({ title: `color.alpha: ${out}`, metadata: { action, result: out }, output: out })
          }

          if (action === "complement") {
            const c = parseColor(params.value!)
            const h = rgbToHsl(c)
            h.h = (h.h + 180) % 360
            const out = toHex(hslToRgb(h))
            return done({ title: `color.complement: ${out}`, metadata: { action, result: out }, output: out })
          }

          if (action === "luminance") {
            const r = relativeLuminance(parseColor(params.value!))
            return done({ title: `color.luminance: ${r.toFixed(4)}`, metadata: { action, result: r }, output: String(r) })
          }

          if (action === "is_dark" || action === "is_light") {
            const lu = relativeLuminance(parseColor(params.value!))
            const dark = lu < 0.179
            const r = action === "is_dark" ? dark : !dark
            return done({ title: `color.${action}: ${r}`, metadata: { action, result: r }, output: String(r) })
          }

          if (action === "mix") {
            if (!params.a || !params.b) throw new Error("color.mix: requires `a` and `b`")
            const ca = parseColor(params.a)
            const cb = parseColor(params.b)
            const t = params.amount ?? 0.5
            const mixed: RGBA = {
              r: ca.r * (1 - t) + cb.r * t,
              g: ca.g * (1 - t) + cb.g * t,
              b: ca.b * (1 - t) + cb.b * t,
              a: ca.a * (1 - t) + cb.a * t,
            }
            const out = mixed.a < 1 ? toRgba(mixed) : toHex(mixed)
            return done({ title: `color.mix: ${out}`, metadata: { action, result: out }, output: out })
          }

          if (action === "contrast") {
            if (!params.a || !params.b) throw new Error("color.contrast: requires `a` and `b`")
            const ca = parseColor(params.a)
            const cb = parseColor(params.b)
            const ratio = +contrastRatio(ca, cb).toFixed(2)
            const result = {
              ratio,
              AA_normal: ratio >= 4.5,
              AA_large: ratio >= 3,
              AAA_normal: ratio >= 7,
              AAA_large: ratio >= 4.5,
            }
            return done({
              title: `color.contrast: ${ratio}:1`,
              metadata: { action, result },
              output: JSON.stringify(result, null, 2),
            })
          }

          throw new Error(`color: unknown action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  parseColor,
  toHex,
  toRgb,
  toHsl,
  rgbToHsl,
  hslToRgb,
  rgbToHsv,
  hsvToRgb,
  relativeLuminance,
  contrastRatio,
}
