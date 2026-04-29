import { Effect, Schema } from "effect"
import DESCRIPTION from "./math.txt"
import * as Tool from "./tool"

const ACTIONS = ["eval", "reduce"] as const
const REDUCERS = ["sum", "mean", "median", "min", "max", "product", "stddev", "variance", "count"] as const

const MAX_EXPRESSION_LENGTH = 4096

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "'eval' for an expression, 'reduce' for an array reduction (sum/mean/etc.).",
  }),
  expression: Schema.optional(Schema.String).annotate({
    description: "Math expression for action='eval'. Up to 4 KiB.",
  }),
  vars: Schema.optional(Schema.Record(Schema.String, Schema.Number)).annotate({
    description: "Optional named variable map for action='eval'.",
  }),
  values: Schema.optional(Schema.Array(Schema.Number)).annotate({
    description: "Array of numbers for action='reduce'.",
  }),
  reducer: Schema.optional(Schema.Literals(REDUCERS)).annotate({
    description: "Reducer for action='reduce'.",
  }),
  precision: Schema.optional(
    Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(15)),
  ).annotate({
    description: "Optional decimal places to round the final result to.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Reducer = (typeof REDUCERS)[number]

type Metadata = {
  action: Action
  value?: number
  expression?: string
  vars?: Record<string, number>
  reducer?: Reducer
  count?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ============================================================
// Tokenizer
// ============================================================

type Token =
  | { kind: "num"; value: number; pos: number }
  | { kind: "id"; value: string; pos: number }
  | { kind: "op"; value: string; pos: number }
  | { kind: "lparen" | "rparen" | "comma"; pos: number }
  | { kind: "eof"; pos: number }

function tokenize(input: string): Token[] {
  const out: Token[] = []
  let i = 0
  const len = input.length
  while (i < len) {
    const c = input[i]!
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++
      continue
    }
    if ((c >= "0" && c <= "9") || (c === "." && i + 1 < len && input[i + 1]! >= "0" && input[i + 1]! <= "9")) {
      const start = i
      while (i < len && /[0-9_]/.test(input[i]!)) i++
      if (i < len && input[i] === ".") {
        i++
        while (i < len && /[0-9_]/.test(input[i]!)) i++
      }
      if (i < len && (input[i] === "e" || input[i] === "E")) {
        i++
        if (i < len && (input[i] === "+" || input[i] === "-")) i++
        while (i < len && /[0-9_]/.test(input[i]!)) i++
      }
      const raw = input.slice(start, i).replace(/_/g, "")
      const num = Number(raw)
      if (!Number.isFinite(num) && raw !== "Infinity") {
        // We'll allow the parser to surface NaN/Inf for runtime but not as literals.
        throw new Error(`math: invalid number literal '${raw}' at ${start}`)
      }
      out.push({ kind: "num", value: num, pos: start })
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i
      while (i < len && /[A-Za-z_0-9]/.test(input[i]!)) i++
      out.push({ kind: "id", value: input.slice(start, i), pos: start })
      continue
    }
    if (c === "*" && input[i + 1] === "*") {
      out.push({ kind: "op", value: "^", pos: i })
      i += 2
      continue
    }
    if (c === "(") {
      out.push({ kind: "lparen", pos: i })
      i++
      continue
    }
    if (c === ")") {
      out.push({ kind: "rparen", pos: i })
      i++
      continue
    }
    if (c === ",") {
      out.push({ kind: "comma", pos: i })
      i++
      continue
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "%" || c === "^") {
      out.push({ kind: "op", value: c, pos: i })
      i++
      continue
    }
    throw new Error(`math: unexpected character '${c}' at ${i}`)
  }
  out.push({ kind: "eof", pos: input.length })
  return out
}

// ============================================================
// Parser (Pratt-ish): expression → addsub → muldiv → power → unary → atom
// ============================================================

class Parser {
  pos = 0
  constructor(
    public tokens: Token[],
    public vars: Record<string, number>,
  ) {}

  peek(): Token {
    return this.tokens[this.pos]!
  }

  consume(): Token {
    return this.tokens[this.pos++]!
  }

  expect<K extends Token["kind"]>(kind: K, label?: string): Token & { kind: K } {
    const t = this.peek()
    if (t.kind !== kind) {
      throw new Error(`math: expected ${label ?? kind} at ${t.pos}, got ${t.kind}`)
    }
    return this.consume() as Token & { kind: K }
  }

  parse(): number {
    const v = this.parseExpression()
    if (this.peek().kind !== "eof") {
      throw new Error(`math: unexpected token '${(this.peek() as any).value ?? this.peek().kind}' at ${this.peek().pos}`)
    }
    return v
  }

  parseExpression(): number {
    let left = this.parseTerm()
    while (true) {
      const t = this.peek()
      if (t.kind === "op" && (t.value === "+" || t.value === "-")) {
        this.consume()
        const right = this.parseTerm()
        left = t.value === "+" ? left + right : left - right
        continue
      }
      break
    }
    return left
  }

  parseTerm(): number {
    let left = this.parsePower()
    while (true) {
      const t = this.peek()
      if (t.kind === "op" && (t.value === "*" || t.value === "/" || t.value === "%")) {
        this.consume()
        const right = this.parsePower()
        if (t.value === "*") left = left * right
        else if (t.value === "/") left = left / right
        else left = left % right
        continue
      }
      break
    }
    return left
  }

  parsePower(): number {
    const left = this.parseUnary()
    const t = this.peek()
    if (t.kind === "op" && t.value === "^") {
      this.consume()
      // Right-associative.
      const right = this.parsePower()
      return Math.pow(left, right)
    }
    return left
  }

  parseUnary(): number {
    const t = this.peek()
    if (t.kind === "op" && (t.value === "+" || t.value === "-")) {
      this.consume()
      const v = this.parseUnary()
      return t.value === "-" ? -v : v
    }
    return this.parseAtom()
  }

  parseAtom(): number {
    const t = this.peek()
    if (t.kind === "num") {
      this.consume()
      return t.value
    }
    if (t.kind === "lparen") {
      this.consume()
      const v = this.parseExpression()
      this.expect("rparen", "')'")
      return v
    }
    if (t.kind === "id") {
      this.consume()
      const name = t.value
      // Function call?
      if (this.peek().kind === "lparen") {
        this.consume()
        const args: number[] = []
        if (this.peek().kind !== "rparen") {
          args.push(this.parseExpression())
          while (this.peek().kind === "comma") {
            this.consume()
            args.push(this.parseExpression())
          }
        }
        this.expect("rparen", "')'")
        return callFunction(name, args)
      }
      // Constant or variable.
      const lower = name.toLowerCase()
      if (lower === "pi") return Math.PI
      if (lower === "e") return Math.E
      if (lower === "tau") return Math.PI * 2
      if (lower === "inf" || lower === "infinity") return Infinity
      if (lower === "nan") return NaN
      if (Object.prototype.hasOwnProperty.call(this.vars, name)) return this.vars[name]!
      throw new Error(`math: unknown identifier '${name}' at ${t.pos}`)
    }
    throw new Error(`math: unexpected token '${(t as any).value ?? t.kind}' at ${t.pos}`)
  }
}

// ============================================================
// Functions
// ============================================================

function arity(name: string, args: number[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`math: function ${name}() expected ${expected} argument(s), got ${args.length}`)
  }
}

function callFunction(name: string, args: number[]): number {
  const n = name.toLowerCase()
  switch (n) {
    case "abs":
      arity(name, args, 1)
      return Math.abs(args[0]!)
    case "sign":
      arity(name, args, 1)
      return Math.sign(args[0]!)
    case "round":
      arity(name, args, 1)
      return Math.round(args[0]!)
    case "floor":
      arity(name, args, 1)
      return Math.floor(args[0]!)
    case "ceil":
      arity(name, args, 1)
      return Math.ceil(args[0]!)
    case "trunc":
      arity(name, args, 1)
      return Math.trunc(args[0]!)
    case "sqrt":
      arity(name, args, 1)
      return Math.sqrt(args[0]!)
    case "cbrt":
      arity(name, args, 1)
      return Math.cbrt(args[0]!)
    case "exp":
      arity(name, args, 1)
      return Math.exp(args[0]!)
    case "log":
    case "ln":
      arity(name, args, 1)
      return Math.log(args[0]!)
    case "log2":
      arity(name, args, 1)
      return Math.log2(args[0]!)
    case "log10":
      arity(name, args, 1)
      return Math.log10(args[0]!)
    case "sin":
      arity(name, args, 1)
      return Math.sin(args[0]!)
    case "cos":
      arity(name, args, 1)
      return Math.cos(args[0]!)
    case "tan":
      arity(name, args, 1)
      return Math.tan(args[0]!)
    case "asin":
      arity(name, args, 1)
      return Math.asin(args[0]!)
    case "acos":
      arity(name, args, 1)
      return Math.acos(args[0]!)
    case "atan":
      arity(name, args, 1)
      return Math.atan(args[0]!)
    case "atan2":
      arity(name, args, 2)
      return Math.atan2(args[0]!, args[1]!)
    case "sinh":
      arity(name, args, 1)
      return Math.sinh(args[0]!)
    case "cosh":
      arity(name, args, 1)
      return Math.cosh(args[0]!)
    case "tanh":
      arity(name, args, 1)
      return Math.tanh(args[0]!)
    case "asinh":
      arity(name, args, 1)
      return Math.asinh(args[0]!)
    case "acosh":
      arity(name, args, 1)
      return Math.acosh(args[0]!)
    case "atanh":
      arity(name, args, 1)
      return Math.atanh(args[0]!)
    case "min":
      if (args.length === 0) throw new Error("math: min() requires ≥1 argument")
      return Math.min(...args)
    case "max":
      if (args.length === 0) throw new Error("math: max() requires ≥1 argument")
      return Math.max(...args)
    case "pow":
      arity(name, args, 2)
      return Math.pow(args[0]!, args[1]!)
    case "hypot":
      if (args.length === 0) throw new Error("math: hypot() requires ≥1 argument")
      return Math.hypot(...args)
    case "clamp": {
      arity(name, args, 3)
      const [x, lo, hi] = args as [number, number, number]
      if (lo > hi) throw new Error("math: clamp() lo must be ≤ hi")
      return Math.min(Math.max(x, lo), hi)
    }
    case "gcd":
      arity(name, args, 2)
      return gcd(args[0]!, args[1]!)
    case "lcm":
      arity(name, args, 2)
      return lcm(args[0]!, args[1]!)
    case "factorial":
      arity(name, args, 1)
      return factorial(args[0]!)
  }
  throw new Error(`math: unknown function '${name}()'`)
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a))
  let y = Math.abs(Math.trunc(b))
  if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN
  while (y) {
    const t = y
    y = x % y
    x = t
  }
  return x
}

function lcm(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return Math.abs(Math.trunc(a) * Math.trunc(b)) / gcd(a, b)
}

function factorial(n: number): number {
  if (!Number.isFinite(n) || n < 0 || n !== Math.trunc(n)) {
    throw new Error("math: factorial() requires a non-negative integer")
  }
  if (n > 170) {
    throw new Error("math: factorial(n>170) overflows double-precision (use bigint elsewhere)")
  }
  let acc = 1
  for (let i = 2; i <= n; i++) acc *= i
  return acc
}

// ============================================================
// Public API
// ============================================================

export function evaluate(expression: string, vars: Record<string, number> = {}): number {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`math: expression exceeds ${MAX_EXPRESSION_LENGTH} characters`)
  }
  const tokens = tokenize(expression)
  const parser = new Parser(tokens, vars)
  return parser.parse()
}

export function reduce(reducer: Reducer, values: readonly number[]): number {
  if (reducer === "count") return values.length
  if (values.length === 0) {
    if (reducer === "min" || reducer === "max" || reducer === "median" || reducer === "mean") return NaN
    if (reducer === "stddev" || reducer === "variance") return NaN
    if (reducer === "sum") return 0
    if (reducer === "product") return 1
  }
  if (reducer === "sum") return values.reduce((a, b) => a + b, 0)
  if (reducer === "product") return values.reduce((a, b) => a * b, 1)
  if (reducer === "min") return Math.min(...values)
  if (reducer === "max") return Math.max(...values)
  if (reducer === "mean") return values.reduce((a, b) => a + b, 0) / values.length
  if (reducer === "median") {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  }
  if (reducer === "variance" || reducer === "stddev") {
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const v = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
    return reducer === "variance" ? v : Math.sqrt(v)
  }
  throw new Error(`math: unknown reducer '${reducer}'`)
}

function applyPrecision(v: number, precision: number | undefined): number {
  if (precision === undefined) return v
  if (!Number.isFinite(v)) return v
  const m = Math.pow(10, precision)
  return Math.round(v * m) / m
}

export const MathTool = Tool.define(
  "math",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          if (action === "eval") {
            if (typeof params.expression !== "string" || params.expression.length === 0) {
              throw new Error("math: 'expression' is required for action='eval'")
            }
            const vars = (params.vars ?? {}) as Record<string, number>
            const raw = evaluate(params.expression, vars)
            const value = applyPrecision(raw, params.precision)
            return done({
              title: `math.eval: ${value}`,
              metadata: {
                action,
                value,
                expression: params.expression,
                vars: Object.keys(vars).length ? vars : undefined,
              },
              output: String(value),
            })
          }
          if (action === "reduce") {
            if (!params.values) throw new Error("math: 'values' is required for action='reduce'")
            if (!params.reducer) throw new Error("math: 'reducer' is required for action='reduce'")
            const reducer = params.reducer as Reducer
            const raw = reduce(reducer, params.values)
            const value = applyPrecision(raw, params.precision)
            return done({
              title: `math.${reducer}: ${value}`,
              metadata: {
                action,
                reducer,
                value,
                count: params.values.length,
              },
              output: String(value),
            })
          }
          throw new Error(`math: unsupported action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  evaluate,
  reduce,
  tokenize,
  gcd,
  lcm,
  factorial,
  applyPrecision,
}
