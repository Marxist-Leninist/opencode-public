import { Effect, Schema } from "effect"
import DESCRIPTION from "./latlon.txt"
import * as Tool from "./tool"

const ACTIONS = ["distance", "bearing", "midpoint", "destination", "bbox", "parse", "format", "validate"] as const
const UNITS = ["km", "m", "mi", "nmi"] as const
const ALGORITHMS = ["haversine", "vincenty"] as const
const BEARING_KINDS = ["initial", "final"] as const
const FORMATS = ["decimal", "dms"] as const

const PointShape = Schema.Struct({
  lat: Schema.Number,
  lon: Schema.Number,
})

const PointInput = Schema.Union([PointShape, Schema.String])

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  from: Schema.optional(PointInput).annotate({
    description: "Start point. {lat,lon} object or string (decimal/DMS).",
  }),
  to: Schema.optional(PointInput).annotate({
    description: "End point. {lat,lon} object or string.",
  }),
  lat: Schema.optional(Schema.Number).annotate({ description: "Latitude in decimal degrees." }),
  lon: Schema.optional(Schema.Number).annotate({ description: "Longitude in decimal degrees." }),
  bearing: Schema.optional(Schema.Number).annotate({ description: "Bearing in degrees clockwise from north." }),
  distance: Schema.optional(Schema.Number).annotate({ description: "Distance in `unit`." }),
  unit: Schema.optional(Schema.Literals(UNITS)).annotate({ description: UNITS.join(" | ") }),
  algorithm: Schema.optional(Schema.Literals(ALGORITHMS)).annotate({ description: ALGORITHMS.join(" | ") }),
  kind: Schema.optional(Schema.Literals(BEARING_KINDS)).annotate({ description: BEARING_KINDS.join(" | ") }),
  format: Schema.optional(Schema.Literals(FORMATS)).annotate({ description: FORMATS.join(" | ") }),
  precision: Schema.optional(Schema.Number).annotate({ description: "Decimal places for outputs." }),
  value: Schema.optional(Schema.String).annotate({ description: "Coordinate string for `parse`." }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Unit = (typeof UNITS)[number]
type Algorithm = (typeof ALGORITHMS)[number]
type BearingKind = (typeof BEARING_KINDS)[number]
type Fmt = (typeof FORMATS)[number]

type Point = { lat: number; lon: number }

type Metadata = {
  action: Action
  unit?: Unit
  algorithm?: Algorithm | "haversine_fallback"
  distance?: number
  bearing?: number
  initial_bearing?: number
  final_bearing?: number
  midpoint?: Point
  destination?: Point
  bbox?: { min: Point; max: Point; crosses_antimeridian?: boolean }
  point?: Point
  formatted?: string
  ok?: boolean
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- helpers ----------

const EARTH_R_KM = 6371.0
const EARTH_R_M = 6371000
const KM_PER_MI = 1.609344
const KM_PER_NMI = 1.852

function toRad(d: number): number {
  return (d * Math.PI) / 180
}
function toDeg(r: number): number {
  return (r * 180) / Math.PI
}

function unitToKm(d: number, u: Unit): number {
  switch (u) {
    case "km":
      return d
    case "m":
      return d / 1000
    case "mi":
      return d * KM_PER_MI
    case "nmi":
      return d * KM_PER_NMI
  }
}
function kmToUnit(d: number, u: Unit): number {
  switch (u) {
    case "km":
      return d
    case "m":
      return d * 1000
    case "mi":
      return d / KM_PER_MI
    case "nmi":
      return d / KM_PER_NMI
  }
}

function clampLat(lat: number): number {
  return Math.max(-90, Math.min(90, lat))
}

function normalizeLon(lon: number): number {
  let x = ((lon + 180) % 360 + 360) % 360 - 180
  // Avoid -180 vs 180 ambiguity for exact +/-180 boundaries.
  if (x === -180) x = 180
  return x
}

function validateLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}

// Parse decimal/DMS coordinate strings.
// Supports forms like:
//   "51.5074, -0.1278"
//   "51.5074N, 0.1278W"
//   "51deg28'38\"N 0deg00'05\"W"
//   "51 28 38 N, 0 0 5 W"
//   "51:28:38N 0:00:05W"
//   "-33.86 151.21" (space- or comma-separated decimal)
export function parseCoordinate(s: string): Point {
  if (typeof s !== "string") throw new Error("parseCoordinate: not a string")
  const raw = s.trim()
  if (!raw) throw new Error("parseCoordinate: empty input")
  // Split into two halves on a comma; if no comma, find a midpoint by hemisphere markers
  // or by counting numbers.
  const halves = splitHalves(raw)
  if (halves.length !== 2) {
    throw new Error(`parseCoordinate: expected 2 components, got ${halves.length} (input: "${s}")`)
  }
  const lat = parseSingle(halves[0], "lat")
  const lon = parseSingle(halves[1], "lon")
  if (!validateLatLon(lat, lon)) {
    throw new Error(`parseCoordinate: invalid lat/lon (${lat}, ${lon})`)
  }
  return { lat, lon }
}

function splitHalves(raw: string): string[] {
  if (raw.includes(",")) {
    const parts = raw.split(",").map((x) => x.trim()).filter(Boolean)
    return parts
  }
  // No comma: try splitting on hemisphere markers, then fall back to half-by-numbers.
  const m = raw.match(/^(.*?[NnSs])\s+(.*)$/)
  if (m) return [m[1].trim(), m[2].trim()]
  // Otherwise try to split into halves by token count.
  const tokens = raw.split(/\s+/)
  if (tokens.length % 2 === 0 && tokens.length >= 2) {
    const half = tokens.length / 2
    return [tokens.slice(0, half).join(" "), tokens.slice(half).join(" ")]
  }
  // Last resort: try DMS x 2 with no spaces between.
  const dms2 = raw.match(
    /^(-?\d+(?:\.\d+)?(?:\u00b0|\s*deg)?(?:[^A-Za-z]*[NnSs])?)\s*[\s,;]\s*(-?\d+(?:\.\d+)?(?:\u00b0|\s*deg)?(?:[^A-Za-z]*[EeWw])?)$/,
  )
  if (dms2) return [dms2[1], dms2[2]]
  return [raw]
}

type Hemisphere = "N" | "S" | "E" | "W"

function isAsciiLetter(value: string | undefined): boolean {
  return value != null && /^[A-Za-z]$/.test(value)
}

function hemisphereSign(value: Hemisphere): number {
  return value === "S" || value === "W" ? -1 : 1
}

function stripHemisphereMarkers(input: string, kind: "lat" | "lon"): { body: string; sign: number } {
  const markers: Array<{ value: Hemisphere; index: number }> = []
  for (const match of input.matchAll(/[NSEW]/gi)) {
    const index = match.index ?? 0
    const previous = index > 0 ? input[index - 1] : undefined
    const next = index + 1 < input.length ? input[index + 1] : undefined
    if (isAsciiLetter(previous) || isAsciiLetter(next)) continue
    markers.push({ value: match[0].toUpperCase() as Hemisphere, index })
  }
  if (markers.length === 0) return { body: input, sign: 1 }

  const allowed = kind === "lat" ? /^[NS]$/ : /^[EW]$/
  let sign: number | undefined
  let body = ""
  let offset = 0
  for (const marker of markers) {
    if (!allowed.test(marker.value)) {
      throw new Error(`parseCoordinate: ${marker.value} hemisphere is invalid for ${kind}`)
    }
    const markerSign = hemisphereSign(marker.value)
    if (sign != null && sign !== markerSign) {
      throw new Error(`parseCoordinate: conflicting hemisphere markers in ${kind} "${input}"`)
    }
    sign = markerSign
    body += input.slice(offset, marker.index) + " "
    offset = marker.index + 1
  }
  body += input.slice(offset)
  return { body: body.trim(), sign: sign ?? 1 }
}

function parseSingle(s: string, kind: "lat" | "lon"): number {
  const t = s.trim()
  if (!t) throw new Error(`parseCoordinate: empty ${kind}`)
  // Hemisphere suffix or prefix.
  const hemisphere = stripHemisphereMarkers(t, kind)
  const sign = hemisphere.sign
  let body = hemisphere.body
  // Replace common DMS punctuation with whitespace.
  body = body.replace(/\u00b0|\u00ba|\u2032|\u2019|'|"|\u2033|:|deg/gi, " ")
  body = body.replace(/\s+/g, " ").trim()
  // If body has multiple numbers, treat as D[ M[ S]].
  const nums = body.match(/-?\d+(?:\.\d+)?/g)
  if (!nums || nums.length === 0) throw new Error(`parseCoordinate: no number in ${kind} "${s}"`)
  if (nums.length > 3) throw new Error(`parseCoordinate: too many numbers in ${kind} "${s}"`)
  const d = parseFloat(nums[0])
  const m = nums.length > 1 ? parseFloat(nums[1]) : 0
  const sec = nums.length > 2 ? parseFloat(nums[2]) : 0
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(sec)) {
    throw new Error(`parseCoordinate: invalid number in ${kind} "${s}"`)
  }
  if (m < 0 || m >= 60 || sec < 0 || sec >= 60) {
    throw new Error(`parseCoordinate: invalid DMS minutes/seconds in ${kind} "${s}"`)
  }
  const mag = Math.abs(d) + m / 60 + sec / 3600
  const finalSign = (d < 0 ? -1 : 1) * sign
  return finalSign * mag
}

export function formatCoordinate(p: Point, fmt: Fmt = "decimal", precision = 6): string {
  if (fmt === "decimal") {
    const lat = p.lat.toFixed(precision)
    const lon = p.lon.toFixed(precision)
    return `${lat}, ${lon}`
  }
  return `${dms(p.lat, "lat", precision)} ${dms(p.lon, "lon", precision)}`
}

function dms(value: number, kind: "lat" | "lon", precision: number): string {
  const abs = Math.abs(value)
  const d = Math.floor(abs)
  const mFloat = (abs - d) * 60
  const m = Math.floor(mFloat)
  const s = (mFloat - m) * 60
  const hem = kind === "lat" ? (value < 0 ? "S" : "N") : value < 0 ? "W" : "E"
  return `${d}deg${String(m).padStart(2, "0")}'${s.toFixed(Math.max(0, precision - 4))}"${hem}`
}

function asPoint(v: Point | string | undefined, name: string): Point {
  if (v == null) throw new Error(`latlon: missing '${name}'`)
  if (typeof v === "string") return parseCoordinate(v)
  if (!validateLatLon(v.lat, v.lon)) throw new Error(`latlon: invalid '${name}' (${v.lat}, ${v.lon})`)
  return { lat: v.lat, lon: v.lon }
}

// ---------- core math ----------

export function haversineKm(a: Point, b: Point): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const la1 = toRad(a.lat)
  const la2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function vincentyMeters(a: Point, b: Point): { distance: number; converged: boolean } {
  // WGS-84
  const aR = 6378137.0
  const f = 1 / 298.257223563
  const bR = (1 - f) * aR
  const L = toRad(b.lon - a.lon)
  const U1 = Math.atan((1 - f) * Math.tan(toRad(a.lat)))
  const U2 = Math.atan((1 - f) * Math.tan(toRad(b.lat)))
  const sinU1 = Math.sin(U1)
  const cosU1 = Math.cos(U1)
  const sinU2 = Math.sin(U2)
  const cosU2 = Math.cos(U2)
  let lambda = L
  let prev = 0
  let iter = 0
  let cosSqAlpha = 0
  let sinSigma = 0
  let cosSigma = 0
  let sigma = 0
  let cos2SigmaM = 0
  while (iter++ < 200) {
    const sinLambda = Math.sin(lambda)
    const cosLambda = Math.cos(lambda)
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    )
    if (sinSigma === 0) return { distance: 0, converged: true } // coincident
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda
    sigma = Math.atan2(sinSigma, cosSigma)
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma
    cosSqAlpha = 1 - sinAlpha * sinAlpha
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha
    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha))
    prev = lambda
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))
    if (Math.abs(lambda - prev) < 1e-12) {
      const uSq = cosSqAlpha * (aR * aR - bR * bR) / (bR * bR)
      const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)))
      const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))
      const deltaSigma =
        B *
        sinSigma *
        (cos2SigmaM +
          (B / 4) *
            (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
              (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)))
      const s = bR * A * (sigma - deltaSigma)
      return { distance: s, converged: true }
    }
  }
  return { distance: NaN, converged: false }
}

export function bearingDeg(from: Point, to: Point): number {
  const la1 = toRad(from.lat)
  const la2 = toRad(to.lat)
  const dLon = toRad(to.lon - from.lon)
  const y = Math.sin(dLon) * Math.cos(la2)
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

export function finalBearingDeg(from: Point, to: Point): number {
  return (bearingDeg(to, from) + 180) % 360
}

export function midpoint(from: Point, to: Point): Point {
  const la1 = toRad(from.lat)
  const la2 = toRad(to.lat)
  const lo1 = toRad(from.lon)
  const dLon = toRad(to.lon - from.lon)
  const Bx = Math.cos(la2) * Math.cos(dLon)
  const By = Math.cos(la2) * Math.sin(dLon)
  const lat = Math.atan2(Math.sin(la1) + Math.sin(la2), Math.sqrt((Math.cos(la1) + Bx) ** 2 + By ** 2))
  const lon = lo1 + Math.atan2(By, Math.cos(la1) + Bx)
  return { lat: toDeg(lat), lon: normalizeLon(toDeg(lon)) }
}

export function destinationPoint(from: Point, bearing: number, distanceKm: number): Point {
  const sigma = distanceKm / EARTH_R_KM
  const theta = toRad(bearing)
  const la1 = toRad(from.lat)
  const lo1 = toRad(from.lon)
  const lat = Math.asin(Math.sin(la1) * Math.cos(sigma) + Math.cos(la1) * Math.sin(sigma) * Math.cos(theta))
  const lon =
    lo1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(sigma) * Math.cos(la1),
      Math.cos(sigma) - Math.sin(la1) * Math.sin(lat),
    )
  return { lat: toDeg(lat), lon: normalizeLon(toDeg(lon)) }
}

export function bboxAround(p: Point, distanceKm: number): { min: Point; max: Point; crosses_antimeridian: boolean } {
  const r = distanceKm / EARTH_R_KM
  const dLat = toDeg(r)
  const cosLat = Math.cos(toRad(p.lat))
  const dLon = cosLat <= 1e-12 ? 360 : toDeg(r / cosLat)
  const minLat = clampLat(p.lat - dLat)
  const maxLat = clampLat(p.lat + dLat)
  let minLon = p.lon - dLon
  let maxLon = p.lon + dLon
  let crosses = false
  if (maxLon - minLon >= 360) {
    minLon = -180
    maxLon = 180
  } else {
    const nMin = normalizeLon(minLon)
    const nMax = normalizeLon(maxLon)
    if (nMin > nMax) crosses = true
    minLon = nMin
    maxLon = nMax
  }
  return { min: { lat: minLat, lon: minLon }, max: { lat: maxLat, lon: maxLon }, crosses_antimeridian: crosses }
}

// ---------- tool ----------

export const LatLonTool = Tool.define(
  "latlon",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const unit: Unit = params.unit ?? "km"
          const distPrec = params.precision ?? 3
          const coordPrec = params.precision ?? 6

          if (action === "validate") {
            if (typeof params.lat !== "number" || typeof params.lon !== "number") {
              throw new Error("latlon.validate: requires numeric lat and lon")
            }
            const ok = validateLatLon(params.lat, params.lon)
            return done({
              title: `latlon.validate: ${ok}`,
              metadata: { action, ok },
              output: String(ok),
            })
          }

          if (action === "parse") {
            if (typeof params.value !== "string") throw new Error("latlon.parse: missing 'value'")
            const p = parseCoordinate(params.value)
            return done({
              title: `latlon.parse: ${formatCoordinate(p)}`,
              metadata: { action, point: p, formatted: formatCoordinate(p, "decimal", coordPrec) },
              output: formatCoordinate(p, "decimal", coordPrec),
            })
          }

          if (action === "format") {
            const p: Point =
              typeof params.lat === "number" && typeof params.lon === "number"
                ? { lat: params.lat, lon: params.lon }
                : asPoint(params.from, "from")
            if (!validateLatLon(p.lat, p.lon)) throw new Error("latlon.format: invalid lat/lon")
            const fmt: Fmt = params.format ?? "decimal"
            const out = formatCoordinate(p, fmt, coordPrec)
            return done({
              title: `latlon.format ${fmt}: ${out}`,
              metadata: { action, point: p, formatted: out },
              output: out,
            })
          }

          if (action === "distance") {
            const a = asPoint(params.from, "from")
            const b = asPoint(params.to, "to")
            const algo: Algorithm = params.algorithm ?? "haversine"
            if (algo === "vincenty") {
              const v = vincentyMeters(a, b)
              if (v.converged) {
                const km = v.distance / 1000
                const out = kmToUnit(km, unit)
                return done({
                  title: `latlon.distance vincenty: ${out.toFixed(distPrec)} ${unit}`,
                  metadata: { action, algorithm: "vincenty", distance: out, unit },
                  output: `${out.toFixed(distPrec)} ${unit}`,
                })
              }
              // Fall back to haversine for non-convergent (near-antipodal).
              const km = haversineKm(a, b)
              const out = kmToUnit(km, unit)
              return done({
                title: `latlon.distance haversine_fallback: ${out.toFixed(distPrec)} ${unit}`,
                metadata: { action, algorithm: "haversine_fallback", distance: out, unit },
                output: `${out.toFixed(distPrec)} ${unit}`,
              })
            }
            const km = haversineKm(a, b)
            const out = kmToUnit(km, unit)
            return done({
              title: `latlon.distance haversine: ${out.toFixed(distPrec)} ${unit}`,
              metadata: { action, algorithm: "haversine", distance: out, unit },
              output: `${out.toFixed(distPrec)} ${unit}`,
            })
          }

          if (action === "bearing") {
            const a = asPoint(params.from, "from")
            const b = asPoint(params.to, "to")
            const kind: BearingKind = params.kind ?? "initial"
            const initial = bearingDeg(a, b)
            const final = finalBearingDeg(a, b)
            const out = kind === "initial" ? initial : final
            return done({
              title: `latlon.bearing ${kind}: ${out.toFixed(distPrec)} deg`,
              metadata: { action, bearing: out, initial_bearing: initial, final_bearing: final },
              output: `${out.toFixed(distPrec)}`,
            })
          }

          if (action === "midpoint") {
            const a = asPoint(params.from, "from")
            const b = asPoint(params.to, "to")
            const m = midpoint(a, b)
            return done({
              title: `latlon.midpoint: ${formatCoordinate(m, "decimal", coordPrec)}`,
              metadata: { action, midpoint: m },
              output: formatCoordinate(m, "decimal", coordPrec),
            })
          }

          if (action === "destination") {
            const a = asPoint(params.from, "from")
            if (typeof params.bearing !== "number") throw new Error("latlon.destination: missing 'bearing'")
            if (typeof params.distance !== "number") throw new Error("latlon.destination: missing 'distance'")
            const km = unitToKm(params.distance, unit)
            const d = destinationPoint(a, params.bearing, km)
            return done({
              title: `latlon.destination: ${formatCoordinate(d, "decimal", coordPrec)}`,
              metadata: { action, destination: d, unit },
              output: formatCoordinate(d, "decimal", coordPrec),
            })
          }

          if (action === "bbox") {
            const a = asPoint(params.from, "from")
            if (typeof params.distance !== "number") throw new Error("latlon.bbox: missing 'distance'")
            const km = unitToKm(params.distance, unit)
            const box = bboxAround(a, km)
            const lines = [
              `min: ${formatCoordinate(box.min, "decimal", coordPrec)}`,
              `max: ${formatCoordinate(box.max, "decimal", coordPrec)}`,
              ...(box.crosses_antimeridian ? ["crosses_antimeridian: true"] : []),
            ]
            return done({
              title: `latlon.bbox`,
              metadata: { action, bbox: box, unit },
              output: lines.join("\n"),
            })
          }

          throw new Error(`latlon: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  parseCoordinate,
  formatCoordinate,
  haversineKm,
  vincentyMeters,
  bearingDeg,
  finalBearingDeg,
  midpoint,
  destinationPoint,
  bboxAround,
  validateLatLon,
  normalizeLon,
  unitToKm,
  kmToUnit,
}
