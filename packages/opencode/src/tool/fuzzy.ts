import { Effect, Schema } from "effect"
import DESCRIPTION from "./fuzzy.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "levenshtein",
  "damerau",
  "hamming",
  "jaro",
  "jaro_winkler",
  "lcs",
  "similarity",
  "best_match",
] as const

const ALGORITHMS = [
  "levenshtein",
  "damerau",
  "hamming",
  "jaro",
  "jaro_winkler",
  "lcs",
  "similarity",
] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  a: Schema.optional(Schema.String).annotate({
    description: "First string for binary ops (levenshtein/damerau/hamming/jaro/jaro_winkler/lcs/similarity).",
  }),
  b: Schema.optional(Schema.String).annotate({
    description: "Second string for binary ops.",
  }),
  value: Schema.optional(Schema.String).annotate({
    description: "Query string for best_match.",
  }),
  candidates: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Candidate strings for best_match.",
  }),
  algorithm: Schema.optional(Schema.Literals(ALGORITHMS)).annotate({
    description: "Algorithm to use for best_match. Default jaro_winkler.",
  }),
  case_sensitive: Schema.optional(Schema.Boolean).annotate({
    description: "If true, compare case-sensitively. Default false.",
  }),
  trim: Schema.optional(Schema.Boolean).annotate({
    description: "Strip leading/trailing whitespace before comparing. Default false.",
  }),
  prefix_weight: Schema.optional(Schema.Number).annotate({
    description: "Jaro-Winkler prefix scaling factor (0-0.25). Default 0.1.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max best_match results. Default 5, capped at 1000.",
  }),
  min_score: Schema.optional(Schema.Number).annotate({
    description: "Drop best_match results scoring below this. Default 0.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Algorithm = (typeof ALGORITHMS)[number]

type Match = {
  value: string
  score: number
  distance?: number
}

type Metadata = {
  action: Action
  algorithm?: Algorithm
  distance?: number
  score?: number
  length?: number
  lcs?: string
  matches?: Match[]
  count?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- algorithms (pure helpers) ----------

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  // Use Uint32 array for performance.
  let prev = new Uint32Array(b.length + 1)
  let cur = new Uint32Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    const ac = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(
        cur[j - 1] + 1, // insert
        prev[j] + 1, // delete
        prev[j - 1] + cost, // substitute
      )
    }
    const tmp = prev
    prev = cur
    cur = tmp
  }
  return prev[b.length]
}

export function damerauLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const m = a.length
  const n = b.length
  // 2D matrix; OK for typical short strings.
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) d[i][0] = i
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // delete
        d[i][j - 1] + 1, // insert
        d[i - 1][j - 1] + cost, // substitute
      )
      if (
        i > 1 &&
        j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1) // transposition
      }
    }
  }
  return d[m][n]
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`hamming: strings must be equal length (got ${a.length} and ${b.length})`)
  }
  let d = 0
  for (let i = 0; i < a.length; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) d++
  }
  return d
}

export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 1 : 1
  if (a.length === 0 || b.length === 0) return 0
  const matchDist = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatch = new Array(a.length).fill(false)
  const bMatch = new Array(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchDist)
    const hi = Math.min(b.length - 1, i + matchDist)
    for (let j = lo; j <= hi; j++) {
      if (bMatch[j]) continue
      if (a.charCodeAt(i) !== b.charCodeAt(j)) continue
      aMatch[i] = true
      bMatch[j] = true
      matches++
      break
    }
  }
  if (matches === 0) return 0
  // Count transpositions.
  let k = 0
  let transpositions = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue
    while (!bMatch[k]) k++
    if (a.charCodeAt(i) !== b.charCodeAt(k)) transpositions++
    k++
  }
  transpositions = Math.floor(transpositions / 2)
  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3
}

export function jaroWinklerSimilarity(a: string, b: string, p = 0.1): number {
  const j = jaroSimilarity(a, b)
  if (j <= 0) return j
  // Common prefix up to 4 chars.
  let l = 0
  const max = Math.min(4, a.length, b.length)
  while (l < max && a.charCodeAt(l) === b.charCodeAt(l)) l++
  const pp = Math.max(0, Math.min(0.25, p))
  return j + l * pp * (1 - j)
}

export function longestCommonSubsequence(a: string, b: string): string {
  if (a.length === 0 || b.length === 0) return ""
  const m = a.length
  const n = b.length
  // Length matrix.
  const len: Uint32Array = new Uint32Array((m + 1) * (n + 1))
  const w = n + 1
  for (let i = 1; i <= m; i++) {
    const ac = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j++) {
      if (ac === b.charCodeAt(j - 1)) {
        len[i * w + j] = len[(i - 1) * w + (j - 1)] + 1
      } else {
        const up = len[(i - 1) * w + j]
        const left = len[i * w + (j - 1)]
        len[i * w + j] = up >= left ? up : left
      }
    }
  }
  // Reconstruct.
  let i = m
  let j = n
  const out: string[] = []
  while (i > 0 && j > 0) {
    if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
      out.push(a[i - 1])
      i--
      j--
    } else if (len[(i - 1) * w + j] >= len[i * w + (j - 1)]) {
      i--
    } else {
      j--
    }
  }
  return out.reverse().join("")
}

export function similarityRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  const d = levenshteinDistance(a, b)
  return 1 - d / max
}

function prep(a: string, params: Params): string {
  let s = a
  if (params.trim) s = s.trim()
  if (!params.case_sensitive) s = s.toLowerCase()
  return s
}

function score(algorithm: Algorithm, a: string, b: string, prefix_weight: number) {
  switch (algorithm) {
    case "levenshtein": {
      const d = levenshteinDistance(a, b)
      const max = Math.max(a.length, b.length)
      const s = max === 0 ? 1 : 1 - d / max
      return { score: s, distance: d }
    }
    case "damerau": {
      const d = damerauLevenshteinDistance(a, b)
      const max = Math.max(a.length, b.length)
      const s = max === 0 ? 1 : 1 - d / max
      return { score: s, distance: d }
    }
    case "hamming": {
      if (a.length !== b.length) return { score: 0, distance: Math.abs(a.length - b.length) }
      const d = hammingDistance(a, b)
      const max = a.length
      const s = max === 0 ? 1 : 1 - d / max
      return { score: s, distance: d }
    }
    case "jaro":
      return { score: jaroSimilarity(a, b) }
    case "jaro_winkler":
      return { score: jaroWinklerSimilarity(a, b, prefix_weight) }
    case "lcs": {
      const lcs = longestCommonSubsequence(a, b)
      const max = Math.max(a.length, b.length)
      return { score: max === 0 ? 1 : lcs.length / max, length: lcs.length }
    }
    case "similarity":
      return { score: similarityRatio(a, b) }
  }
}

// ---------- tool ----------

export const FuzzyTool = Tool.define(
  "fuzzy",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const pw = Math.max(0, Math.min(0.25, params.prefix_weight ?? 0.1))

          if (action === "best_match") {
            if (typeof params.value !== "string") {
              throw new Error("fuzzy.best_match: missing 'value'")
            }
            if (!Array.isArray(params.candidates) || params.candidates.length === 0) {
              throw new Error("fuzzy.best_match: missing or empty 'candidates'")
            }
            const limit = Math.max(1, Math.min(1000, Math.floor(params.limit ?? 5)))
            const minScore = typeof params.min_score === "number" ? params.min_score : 0
            const algo: Algorithm = params.algorithm ?? "jaro_winkler"
            const q = prep(params.value, params)
            const ranked: Match[] = []
            for (const c of params.candidates) {
              const cn = prep(c, params)
              const s = score(algo, q, cn, pw)
              if (s.score < minScore) continue
              ranked.push({
                value: c,
                score: s.score,
                ...(typeof (s as any).distance === "number" ? { distance: (s as any).distance } : {}),
              })
            }
            ranked.sort((x, y) => y.score - x.score)
            const top = ranked.slice(0, limit)
            const lines = top.map(
              (m, i) =>
                `${i + 1}. ${m.value}  [score=${m.score.toFixed(4)}${
                  typeof m.distance === "number" ? `, distance=${m.distance}` : ""
                }]`,
            )
            return done({
              title: `fuzzy.best_match (${algo}): ${top.length}/${params.candidates.length}`,
              metadata: { action, algorithm: algo, matches: top, count: top.length },
              output: lines.length ? lines.join("\n") : "(no matches above min_score)",
            })
          }

          // Binary ops require a/b.
          if (typeof params.a !== "string" || typeof params.b !== "string") {
            throw new Error(`fuzzy.${action}: requires both 'a' and 'b'`)
          }
          const a = prep(params.a, params)
          const b = prep(params.b, params)

          switch (action) {
            case "levenshtein": {
              const d = levenshteinDistance(a, b)
              return done({
                title: `fuzzy.levenshtein: ${d}`,
                metadata: { action, distance: d },
                output: String(d),
              })
            }
            case "damerau": {
              const d = damerauLevenshteinDistance(a, b)
              return done({
                title: `fuzzy.damerau: ${d}`,
                metadata: { action, distance: d },
                output: String(d),
              })
            }
            case "hamming": {
              const d = hammingDistance(a, b)
              return done({
                title: `fuzzy.hamming: ${d}`,
                metadata: { action, distance: d },
                output: String(d),
              })
            }
            case "jaro": {
              const s = jaroSimilarity(a, b)
              return done({
                title: `fuzzy.jaro: ${s.toFixed(4)}`,
                metadata: { action, score: s },
                output: s.toFixed(6),
              })
            }
            case "jaro_winkler": {
              const s = jaroWinklerSimilarity(a, b, pw)
              return done({
                title: `fuzzy.jaro_winkler: ${s.toFixed(4)}`,
                metadata: { action, score: s },
                output: s.toFixed(6),
              })
            }
            case "lcs": {
              const lcs = longestCommonSubsequence(a, b)
              return done({
                title: `fuzzy.lcs: length=${lcs.length}`,
                metadata: { action, length: lcs.length, lcs },
                output: lcs,
              })
            }
            case "similarity": {
              const s = similarityRatio(a, b)
              return done({
                title: `fuzzy.similarity: ${s.toFixed(4)}`,
                metadata: { action, score: s },
                output: s.toFixed(6),
              })
            }
          }

          throw new Error(`fuzzy: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  levenshteinDistance,
  damerauLevenshteinDistance,
  hammingDistance,
  jaroSimilarity,
  jaroWinklerSimilarity,
  longestCommonSubsequence,
  similarityRatio,
  score,
}
