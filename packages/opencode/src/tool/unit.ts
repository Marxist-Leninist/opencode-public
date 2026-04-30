import { Effect, Schema } from "effect"
import DESCRIPTION from "./unit.txt"
import * as Tool from "./tool"

const ACTIONS = ["convert", "categories", "units", "list"] as const
const CATEGORIES = [
  "length",
  "mass",
  "volume",
  "temperature",
  "time",
  "data",
  "speed",
  "area",
  "pressure",
  "energy",
  "power",
  "angle",
  "frequency",
  "fuel_economy",
] as const

type Category = (typeof CATEGORIES)[number]

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  value: Schema.optional(Schema.Number).annotate({
    description: "Numeric value to convert (required for `convert`).",
  }),
  from: Schema.optional(Schema.String).annotate({
    description: "Source unit symbol (required for `convert`).",
  }),
  to: Schema.optional(Schema.String).annotate({
    description: "Target unit symbol (required for `convert`).",
  }),
  category: Schema.optional(Schema.Literals(CATEGORIES)).annotate({
    description: "Filter for `units` (required for `units`).",
  }),
  precision: Schema.optional(Schema.Number).annotate({
    description: "Round output to this many decimal places (0-18). Default unrounded.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Metadata = {
  action: Action
  category?: Category
  from?: string
  to?: string
  value?: number
  result?: number
  unit_count?: number
  units?: string[]
  categories?: typeof CATEGORIES
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- factor tables ----------

// For "ratio" units, factor is "how many base units per 1 of this unit".
// Conversion: result = (value * factor[from]) / factor[to].
const RATIO: Record<Category, Record<string, number>> = {
  length: {
    m: 1,
    cm: 0.01,
    mm: 0.001,
    km: 1000,
    um: 1e-6,
    nm: 1e-9,
    in: 0.0254,
    ft: 0.3048,
    yd: 0.9144,
    mi: 1609.344,
    nmi: 1852,
    au: 149597870700,
    ly: 9460730472580800,
    pc: 30856775814913672,
  },
  mass: {
    g: 1,
    kg: 1000,
    mg: 0.001,
    ug: 1e-6,
    t: 1e6, // metric tonne
    oz: 28.349523125,
    lb: 453.59237,
    st: 6350.29318,
    gr: 0.06479891, // grain
  },
  volume: {
    L: 1,
    mL: 0.001,
    cL: 0.01,
    dL: 0.1,
    m3: 1000,
    cm3: 0.001,
    mm3: 1e-6,
    gal_us: 3.785411784,
    gal_uk: 4.54609,
    qt_us: 0.946352946,
    pt_us: 0.473176473,
    fl_oz_us: 0.0295735295625,
    cup_us: 0.2365882365,
    tbsp: 0.01478676478125, // US tablespoon
    tsp: 0.00492892159375, // US teaspoon
  },
  temperature: { K: 1, C: 1, F: 1, R: 1 }, // sentinel; handled in convertTemp
  time: {
    s: 1,
    ns: 1e-9,
    us: 1e-6,
    ms: 0.001,
    min: 60,
    h: 3600,
    d: 86400,
    wk: 604800,
    mo: 2592000, // 30 days
    yr: 31536000, // 365 days
  },
  data: {
    B: 1,
    KB: 1000,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    PB: 1e15,
    KiB: 1024,
    MiB: 1024 * 1024,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
    PiB: 1024 ** 5,
    bit: 1 / 8,
    Kbit: 1000 / 8,
    Mbit: 1e6 / 8,
    Gbit: 1e9 / 8,
    Tbit: 1e12 / 8,
  },
  speed: {
    mps: 1, // m/s base
    kmh: 1000 / 3600, // 1 km/h = 0.27777... m/s
    mph: 1609.344 / 3600,
    knot: 1852 / 3600,
    fps: 0.3048,
  },
  area: {
    m2: 1,
    cm2: 1e-4,
    mm2: 1e-6,
    km2: 1e6,
    in2: 0.00064516,
    ft2: 0.09290304,
    yd2: 0.83612736,
    ac: 4046.8564224,
    ha: 10000,
    mi2: 2589988.110336,
  },
  pressure: {
    Pa: 1,
    hPa: 100,
    kPa: 1000,
    MPa: 1e6,
    bar: 1e5,
    mbar: 100,
    psi: 6894.757293168,
    atm: 101325,
    torr: 101325 / 760,
    mmHg: 101325 / 760, // approximately torr
  },
  energy: {
    J: 1,
    kJ: 1000,
    MJ: 1e6,
    cal: 4.184,
    kcal: 4184,
    Wh: 3600,
    kWh: 3.6e6,
    MWh: 3.6e9,
    eV: 1.602176634e-19,
    BTU: 1055.05585262,
  },
  power: {
    W: 1,
    kW: 1000,
    MW: 1e6,
    GW: 1e9,
    hp: 745.6998715822702,
    BTU_h: 1055.05585262 / 3600,
  },
  angle: {
    rad: 1,
    deg: Math.PI / 180,
    grad: Math.PI / 200,
    turn: 2 * Math.PI,
    arcmin: Math.PI / (180 * 60),
    arcsec: Math.PI / (180 * 3600),
  },
  frequency: {
    Hz: 1,
    kHz: 1000,
    MHz: 1e6,
    GHz: 1e9,
    THz: 1e12,
    rpm: 1 / 60,
  },
  fuel_economy: { mpg_us: 1, mpg_uk: 1, kml: 1, l_100km: 1 }, // sentinel; handled below
}

// Lowercased aliases that map to canonical symbols. Keep this conservative:
// users can always pass exact case for SI clarity.
const ALIASES: Record<string, string> = {
  // length
  meter: "m",
  meters: "m",
  metre: "m",
  metres: "m",
  centimeter: "cm",
  centimeters: "cm",
  millimeter: "mm",
  millimeters: "mm",
  kilometer: "km",
  kilometers: "km",
  inch: "in",
  inches: "in",
  foot: "ft",
  feet: "ft",
  yard: "yd",
  yards: "yd",
  mile: "mi",
  miles: "mi",
  // mass
  gram: "g",
  grams: "g",
  kilogram: "kg",
  kilograms: "kg",
  milligram: "mg",
  milligrams: "mg",
  microgram: "ug",
  micrograms: "ug",
  pound: "lb",
  pounds: "lb",
  ounce: "oz",
  ounces: "oz",
  tonne: "t",
  tonnes: "t",
  stone: "st",
  // volume
  liter: "L",
  liters: "L",
  litre: "L",
  litres: "L",
  milliliter: "mL",
  milliliters: "mL",
  millilitre: "mL",
  millilitres: "mL",
  gallon: "gal_us",
  gallons: "gal_us",
  // time
  second: "s",
  seconds: "s",
  sec: "s",
  millisecond: "ms",
  milliseconds: "ms",
  microsecond: "us",
  microseconds: "us",
  nanosecond: "ns",
  nanoseconds: "ns",
  minute: "min",
  minutes: "min",
  hour: "h",
  hours: "h",
  hr: "h",
  day: "d",
  days: "d",
  week: "wk",
  weeks: "wk",
  month: "mo",
  months: "mo",
  year: "yr",
  years: "yr",
  // speed
  "m/s": "mps",
  "km/h": "kmh",
  kph: "kmh",
  // pressure
  millibar: "mbar",
  // angle
  radian: "rad",
  radians: "rad",
  degree: "deg",
  degrees: "deg",
  // frequency
  hertz: "Hz",
  hz: "Hz",
  kilohertz: "kHz",
  megahertz: "MHz",
  gigahertz: "GHz",
  // data
  byte: "B",
  bytes: "B",
  kilobyte: "KB",
  kilobytes: "KB",
  megabyte: "MB",
  megabytes: "MB",
  gigabyte: "GB",
  gigabytes: "GB",
  kibibyte: "KiB",
  mebibyte: "MiB",
  gibibyte: "GiB",
  // energy / power
  joule: "J",
  joules: "J",
  watt: "W",
  watts: "W",
  horsepower: "hp",
  // fuel
  "l/100km": "l_100km",
  "km/l": "kml",
  mpg: "mpg_us",
}

function normalizeUnit(u: string): string {
  if (u in ALIASES) return ALIASES[u]
  const lower = u.toLowerCase()
  if (lower in ALIASES) return ALIASES[lower]
  return u
}

function findCategory(unit: string): Category | null {
  for (const cat of CATEGORIES) {
    if (unit in RATIO[cat]) return cat
  }
  return null
}

// ---------- temperature: affine ----------

function tempToKelvin(value: number, unit: string): number {
  switch (unit) {
    case "K":
      return value
    case "C":
      return value + 273.15
    case "F":
      return (value - 32) * (5 / 9) + 273.15
    case "R":
      return value * (5 / 9)
    default:
      throw new Error(`unit.convert: unknown temperature unit '${unit}'`)
  }
}

function tempFromKelvin(k: number, unit: string): number {
  switch (unit) {
    case "K":
      return k
    case "C":
      return k - 273.15
    case "F":
      return (k - 273.15) * (9 / 5) + 32
    case "R":
      return k * (9 / 5)
    default:
      throw new Error(`unit.convert: unknown temperature unit '${unit}'`)
  }
}

function convertTemperature(value: number, from: string, to: string): number {
  return tempFromKelvin(tempToKelvin(value, from), to)
}

// ---------- fuel economy ----------
// Internal base: km per liter (km/L). For l_100km we invert.
// Conversions:
//  - mpg_us -> km/L: mpg_us * (1.609344 / 3.785411784)
//  - mpg_uk -> km/L: mpg_uk * (1.609344 / 4.54609)
//  - kml = km/L (identity)
//  - l_100km <-> km/L: kml = 100 / l_100km, l_100km = 100 / kml
function fuelToKml(value: number, unit: string): number {
  switch (unit) {
    case "mpg_us":
      return value * (1.609344 / 3.785411784)
    case "mpg_uk":
      return value * (1.609344 / 4.54609)
    case "kml":
      return value
    case "l_100km":
      if (value <= 0) throw new Error("unit.convert: l_100km must be positive")
      return 100 / value
    default:
      throw new Error(`unit.convert: unknown fuel_economy unit '${unit}'`)
  }
}

function fuelFromKml(kml: number, unit: string): number {
  switch (unit) {
    case "mpg_us":
      return kml / (1.609344 / 3.785411784)
    case "mpg_uk":
      return kml / (1.609344 / 4.54609)
    case "kml":
      return kml
    case "l_100km":
      if (kml <= 0) throw new Error("unit.convert: cannot represent zero km/L as l_100km")
      return 100 / kml
    default:
      throw new Error(`unit.convert: unknown fuel_economy unit '${unit}'`)
  }
}

// ---------- main convert ----------

export function convert(value: number, fromRaw: string, toRaw: string): { result: number; category: Category } {
  if (!Number.isFinite(value)) throw new Error("unit.convert: value must be finite")
  const from = normalizeUnit(fromRaw)
  const to = normalizeUnit(toRaw)
  const fromCat = findCategory(from)
  const toCat = findCategory(to)
  if (!fromCat) throw new Error(`unit.convert: unknown source unit '${fromRaw}'`)
  if (!toCat) throw new Error(`unit.convert: unknown target unit '${toRaw}'`)
  if (fromCat !== toCat) {
    throw new Error(`unit.convert: '${from}' (${fromCat}) and '${to}' (${toCat}) are not the same category`)
  }
  const cat = fromCat
  if (cat === "temperature") {
    return { result: convertTemperature(value, from, to), category: cat }
  }
  if (cat === "fuel_economy") {
    return { result: fuelFromKml(fuelToKml(value, from), to), category: cat }
  }
  const ratios = RATIO[cat]
  return { result: (value * ratios[from]) / ratios[to], category: cat }
}

function round(value: number, precision?: number): number {
  if (precision === undefined) return value
  if (!Number.isInteger(precision) || precision < 0 || precision > 18) {
    throw new Error("unit.convert: precision must be an integer 0..18")
  }
  const f = Math.pow(10, precision)
  return Math.round(value * f) / f
}

export const UnitTool = Tool.define(
  "unit",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action

          if (action === "convert") {
            if (params.value === undefined) throw new Error("unit.convert: 'value' is required")
            if (!params.from) throw new Error("unit.convert: 'from' is required")
            if (!params.to) throw new Error("unit.convert: 'to' is required")
            const { result, category } = convert(params.value, params.from, params.to)
            const rounded = round(result, params.precision)
            return done({
              title: `unit.convert ${params.value} ${params.from} -> ${rounded} ${params.to}`,
              metadata: {
                action,
                category,
                from: normalizeUnit(params.from),
                to: normalizeUnit(params.to),
                value: params.value,
                result: rounded,
              },
              output: String(rounded),
            })
          }

          if (action === "categories") {
            return done({
              title: `unit.categories (${CATEGORIES.length})`,
              metadata: { action, categories: CATEGORIES, unit_count: CATEGORIES.length },
              output: CATEGORIES.join("\n"),
            })
          }

          if (action === "units") {
            if (!params.category) throw new Error("unit.units: 'category' is required")
            const units = Object.keys(RATIO[params.category]).sort()
            return done({
              title: `unit.units ${params.category} (${units.length})`,
              metadata: { action, category: params.category, units, unit_count: units.length },
              output: units.join("\n"),
            })
          }

          if (action === "list") {
            const lines: string[] = []
            for (const cat of CATEGORIES) {
              const units = Object.keys(RATIO[cat]).sort()
              lines.push(`${cat}: ${units.join(", ")}`)
            }
            return done({
              title: `unit.list (${CATEGORIES.length} categories)`,
              metadata: { action, categories: CATEGORIES },
              output: lines.join("\n"),
            })
          }

          throw new Error(`unit: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  convert,
  convertTemperature,
  fuelToKml,
  fuelFromKml,
  normalizeUnit,
  findCategory,
  CATEGORIES,
  RATIO,
}
