import { Effect, Schema } from "effect"
import DESCRIPTION from "./stats.txt"
import * as Tool from "./tool"

const ACTIONS = ["summary", "quantile", "histogram", "correlation", "zscore", "normalize", "top"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  values: Schema.optional(Schema.Array(Schema.Number)).annotate({
    description: "Array of numbers. Mutually exclusive with values_text. Cap 1,000,000 entries.",
  }),
  values_text: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000_000))).annotate({
    description: "Whitespace/comma/newline-separated number string. Non-numeric tokens are skipped.",
  }),
  values2: Schema.optional(Schema.Array(Schema.Number)).annotate({
    description: "Second array for action=correlation.",
  }),
  qs: Schema.optional(Schema.Array(Schema.Number)).annotate({
    description: "Quantile probabilities (each in [0,1]) for action=quantile.",
  }),
  bins: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1_000)),
  ).annotate({
    description: "Histogram bin count. Default 10.",
  }),
  k: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1_000)),
  ).annotate({
    description: "Count for action=top. Default 10.",
  }),
  bottom: Schema.optional(Schema.Boolean).annotate({
    description: "Reverse order for action=top (return smallest first). Default false.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Metadata = {
  action: Action
  count?: number
  skipped?: number
  notes?: string[]
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function parseValues(params: Params): { values: number[]; skipped: number } {
  if (params.values && params.values.length > 0) {
    if (params.values_text) throw new Error("stats: pass either `values` OR `values_text`, not both")
    if (params.values.length > 1_000_000) throw new Error("stats: values cap is 1,000,000")
    return { values: params.values.slice(), skipped: 0 }
  }
  if (typeof params.values_text === "string" && params.values_text.length > 0) {
    const parts = params.values_text.split(/[\s,;]+/).filter(Boolean)
    const values: number[] = []
    let skipped = 0
    for (const p of parts) {
      const n = Number(p)
      if (Number.isFinite(n)) values.push(n)
      else skipped++
    }
    if (values.length > 1_000_000) throw new Error("stats: values cap is 1,000,000")
    return { values, skipped }
  }
  if (params.values && params.values.length === 0) return { values: [], skipped: 0 }
  throw new Error("stats: provide `values` or `values_text`")
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  if (q <= 0) return sorted[0]
  if (q >= 1) return sorted[sorted.length - 1]
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  const frac = pos - lo
  return sorted[lo] * (1 - frac) + sorted[hi] * frac
}

function summary(values: number[]) {
  const n = values.length
  if (n === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const sum = values.reduce((a, b) => a + b, 0)
  const mean = sum / n
  const min = sorted[0]
  const max = sorted[n - 1]
  const range = max - min
  // Use Welford's algorithm for numerical stability on big inputs.
  let m = 0
  let m2 = 0
  let m3 = 0
  let m4 = 0
  let count = 0
  for (const x of values) {
    count++
    const delta = x - m
    const deltaN = delta / count
    const deltaN2 = deltaN * deltaN
    const term1 = delta * deltaN * (count - 1)
    m += deltaN
    m4 += term1 * deltaN2 * (count * count - 3 * count + 3) + 6 * deltaN2 * m2 - 4 * deltaN * m3
    m3 += term1 * deltaN * (count - 2) - 3 * deltaN * m2
    m2 += term1
  }
  const variance = n >= 2 ? m2 / (n - 1) : 0
  const stddev = Math.sqrt(variance)
  const skewness = n >= 3 && m2 > 0 ? (Math.sqrt(n) * m3) / Math.pow(m2, 1.5) : null
  const kurtosis_excess = n >= 4 && m2 > 0 ? (n * m4) / (m2 * m2) - 3 : null

  const allPositive = values.every((v) => v > 0)
  const geometric_mean = allPositive ? Math.exp(values.reduce((a, b) => a + Math.log(b), 0) / n) : null
  const harmonic_mean = allPositive ? n / values.reduce((a, b) => a + 1 / b, 0) : null

  const p25 = quantile(sorted, 0.25)
  const p50 = quantile(sorted, 0.5)
  const p75 = quantile(sorted, 0.75)
  const p90 = quantile(sorted, 0.9)
  const p95 = quantile(sorted, 0.95)
  const p99 = quantile(sorted, 0.99)
  const median = p50
  const iqr = p75 - p25

  return {
    count: n,
    sum,
    min,
    max,
    range,
    mean,
    median,
    variance,
    stddev,
    p25,
    p50,
    p75,
    p90,
    p95,
    p99,
    iqr,
    skewness,
    kurtosis_excess,
    geometric_mean,
    harmonic_mean,
  }
}

function histogram(values: number[], bins: number) {
  if (values.length === 0) return { bins: [], min: 0, max: 0, width: 0 }
  const sorted = values.slice().sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const width = max === min ? 1 : (max - min) / bins
  const counts = new Array(bins).fill(0)
  for (const v of values) {
    if (max === min) {
      counts[0]++
      continue
    }
    let idx = Math.floor((v - min) / width)
    if (idx >= bins) idx = bins - 1
    if (idx < 0) idx = 0
    counts[idx]++
  }
  const out: { lower: number; upper: number; count: number }[] = []
  for (let i = 0; i < bins; i++) {
    const lower = min + width * i
    const upper = i === bins - 1 ? max : min + width * (i + 1)
    out.push({ lower, upper, count: counts[i] })
  }
  return { bins: out, min, max, width }
}

function correlation(a: number[], b: number[]): number | null {
  if (a.length !== b.length) throw new Error("stats.correlation: values and values2 must have the same length")
  const n = a.length
  if (n < 2) return null
  const meanA = a.reduce((s, x) => s + x, 0) / n
  const meanB = b.reduce((s, x) => s + x, 0) / n
  let num = 0
  let denomA = 0
  let denomB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    num += da * db
    denomA += da * da
    denomB += db * db
  }
  const denom = Math.sqrt(denomA * denomB)
  return denom === 0 ? null : num / denom
}

function zscore(values: number[]): number[] {
  const s = summary(values)
  if (!s || s.stddev === 0) return values.map(() => 0)
  return values.map((v) => (v - s.mean) / s.stddev)
}

function normalize(values: number[]): number[] {
  if (values.length === 0) return []
  let min = values[0]
  let max = values[0]
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  if (max === min) return values.map(() => 0)
  return values.map((v) => (v - min) / (max - min))
}

function top(values: number[], k: number, bottom: boolean): number[] {
  const sorted = values.slice().sort((a, b) => (bottom ? a - b : b - a))
  return sorted.slice(0, k)
}

export const StatsTool = Tool.define(
  "stats",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const { values, skipped } = parseValues(params)
          const notes: string[] = []

          if (action === "summary") {
            const s = summary(values)
            if (!s) {
              return done({
                title: "stats.summary: empty",
                metadata: { action, count: 0, skipped },
                output: JSON.stringify({ count: 0 }),
              })
            }
            if (s.geometric_mean === null) notes.push("geometric/harmonic mean require all values > 0")
            if (s.skewness === null) notes.push("skewness requires n>=3")
            if (s.kurtosis_excess === null) notes.push("kurtosis requires n>=4")
            return done({
              title: `stats.summary n=${s.count} mean=${s.mean.toPrecision(6)} sd=${s.stddev.toPrecision(6)}`,
              metadata: { action, count: s.count, skipped, ...(notes.length ? { notes } : {}) },
              output: JSON.stringify(s, null, 2),
            })
          }

          if (action === "quantile") {
            const qs = params.qs ?? [0.25, 0.5, 0.75]
            for (const q of qs) {
              if (!(q >= 0 && q <= 1)) throw new Error(`stats.quantile: q must be in [0,1], got ${q}`)
            }
            const sorted = values.slice().sort((a, b) => a - b)
            const out = qs.map((q) => ({ q, value: quantile(sorted, q) }))
            return done({
              title: `stats.quantile n=${values.length} qs=${qs.join(",")}`,
              metadata: { action, count: values.length, skipped },
              output: JSON.stringify(out, null, 2),
            })
          }

          if (action === "histogram") {
            const bins = params.bins ?? 10
            const h = histogram(values, bins)
            return done({
              title: `stats.histogram n=${values.length} bins=${bins}`,
              metadata: { action, count: values.length, skipped },
              output: JSON.stringify(h, null, 2),
            })
          }

          if (action === "correlation") {
            if (!params.values2 || params.values2.length === 0)
              throw new Error("stats.correlation: values2 is required")
            const r = correlation(values, params.values2.slice())
            return done({
              title: `stats.correlation n=${values.length} r=${r === null ? "n/a" : r.toPrecision(6)}`,
              metadata: { action, count: values.length, skipped },
              output: JSON.stringify({ r, n: values.length }),
            })
          }

          if (action === "zscore") {
            const z = zscore(values)
            return done({
              title: `stats.zscore n=${values.length}`,
              metadata: { action, count: values.length, skipped },
              output: JSON.stringify(z),
            })
          }

          if (action === "normalize") {
            const out = normalize(values)
            return done({
              title: `stats.normalize n=${values.length}`,
              metadata: { action, count: values.length, skipped },
              output: JSON.stringify(out),
            })
          }

          if (action === "top") {
            const k = params.k ?? 10
            const bottom = params.bottom ?? false
            const out = top(values, k, bottom)
            return done({
              title: `stats.top ${bottom ? "bottom" : "top"} ${k} of ${values.length}`,
              metadata: { action, count: values.length, skipped },
              output: JSON.stringify(out),
            })
          }

          throw new Error(`stats: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  parseValues,
  summary,
  quantile,
  histogram,
  correlation,
  zscore,
  normalize,
  top,
}
