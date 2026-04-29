import { Effect, Schema } from "effect"
import * as nodePath from "node:path"
import { Instance } from "../project/instance"
import DESCRIPTION from "./path.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "parse",
  "join",
  "resolve",
  "normalize",
  "relative",
  "dirname",
  "basename",
  "extname",
  "is_absolute",
  "format",
  "to_posix",
  "to_windows",
  "common_prefix",
  "split",
] as const
const FLAVORS = ["posix", "win32", "auto"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  value: Schema.optional(Schema.String).annotate({ description: "Single path input (most actions)." }),
  parts: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Path parts (join/resolve/common_prefix).",
  }),
  from: Schema.optional(Schema.String).annotate({ description: "Source path for `relative`." }),
  to: Schema.optional(Schema.String).annotate({ description: "Target path for `relative`." }),
  cwd: Schema.optional(Schema.String).annotate({ description: "Base path for resolve. Default = project dir." }),
  ext: Schema.optional(Schema.String).annotate({ description: "Extension to strip (basename) or set (format)." }),
  format_input: Schema.optional(
    Schema.Struct({
      root: Schema.optional(Schema.String),
      dir: Schema.optional(Schema.String),
      base: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      ext: Schema.optional(Schema.String),
    }),
  ).annotate({
    description: "Format input components.",
  }),
  flavor: Schema.optional(Schema.Literals(FLAVORS)).annotate({
    description: "posix | win32 | auto (default).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Flavor = (typeof FLAVORS)[number]

type Metadata = {
  action: Action
  flavor: "posix" | "win32"
  result?: unknown
}

function pickFlavor(flavor: Flavor | undefined): typeof nodePath.posix {
  if (flavor === "posix") return nodePath.posix
  if (flavor === "win32") return nodePath.win32 as any
  return nodePath as any
}

function flavorName(flavor: Flavor | undefined): "posix" | "win32" {
  if (flavor === "posix") return "posix"
  if (flavor === "win32") return "win32"
  return process.platform === "win32" ? "win32" : "posix"
}

export function commonPrefix(parts: readonly string[], sep: string): string {
  if (parts.length === 0) return ""
  if (parts.length === 1) return parts[0]!
  const segments = parts.map((p) => p.split(sep))
  const minLen = Math.min(...segments.map((s) => s.length))
  const out: string[] = []
  for (let i = 0; i < minLen; i++) {
    const seg = segments[0]![i]
    if (segments.every((s) => s[i] === seg)) out.push(seg!)
    else break
  }
  return out.join(sep)
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const PathTool = Tool.define(
  "path",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const flavor = flavorName(params.flavor)
          const p = pickFlavor(params.flavor)

          if (action === "parse") {
            if (params.value === undefined) throw new Error("path.parse: requires `value`")
            const parsed = p.parse(params.value)
            return done({
              title: `path.parse: ${parsed.base || "(empty)"}`,
              metadata: { action, flavor, result: parsed },
              output: JSON.stringify(parsed, null, 2),
            })
          }

          if (action === "join") {
            const parts = params.parts ?? (params.value !== undefined ? [params.value] : [])
            const result = p.join(...parts)
            return done({
              title: `path.join: ${result}`,
              metadata: { action, flavor, result },
              output: result,
            })
          }

          if (action === "resolve") {
            const parts = params.parts ?? (params.value !== undefined ? [params.value] : [])
            const cwd = params.cwd ?? Instance.directory
            const result = p.resolve(cwd, ...parts)
            return done({
              title: `path.resolve: ${result}`,
              metadata: { action, flavor, result },
              output: result,
            })
          }

          if (action === "normalize") {
            if (params.value === undefined) throw new Error("path.normalize: requires `value`")
            const result = p.normalize(params.value)
            return done({
              title: `path.normalize: ${result}`,
              metadata: { action, flavor, result },
              output: result,
            })
          }

          if (action === "relative") {
            if (params.from === undefined || params.to === undefined) {
              throw new Error("path.relative: requires `from` and `to`")
            }
            const result = p.relative(params.from, params.to)
            return done({
              title: `path.relative: ${result || "."}`,
              metadata: { action, flavor, result },
              output: result || ".",
            })
          }

          if (action === "dirname") {
            if (params.value === undefined) throw new Error("path.dirname: requires `value`")
            const result = p.dirname(params.value)
            return done({
              title: `path.dirname: ${result}`,
              metadata: { action, flavor, result },
              output: result,
            })
          }

          if (action === "basename") {
            if (params.value === undefined) throw new Error("path.basename: requires `value`")
            const result = params.ext ? p.basename(params.value, params.ext) : p.basename(params.value)
            return done({
              title: `path.basename: ${result}`,
              metadata: { action, flavor, result },
              output: result,
            })
          }

          if (action === "extname") {
            if (params.value === undefined) throw new Error("path.extname: requires `value`")
            const result = p.extname(params.value)
            return done({
              title: `path.extname: ${result || "(none)"}`,
              metadata: { action, flavor, result },
              output: result,
            })
          }

          if (action === "is_absolute") {
            if (params.value === undefined) throw new Error("path.is_absolute: requires `value`")
            const result = p.isAbsolute(params.value)
            return done({
              title: `path.is_absolute: ${result}`,
              metadata: { action, flavor, result },
              output: String(result),
            })
          }

          if (action === "format") {
            if (!params.format_input) throw new Error("path.format: requires `format_input`")
            const result = p.format(params.format_input)
            return done({
              title: `path.format: ${result}`,
              metadata: { action, flavor, result },
              output: result,
            })
          }

          if (action === "to_posix") {
            if (params.value === undefined) throw new Error("path.to_posix: requires `value`")
            const result = params.value.replace(/\\/g, "/")
            return done({
              title: `path.to_posix: ${result}`,
              metadata: { action, flavor, result },
              output: result,
            })
          }

          if (action === "to_windows") {
            if (params.value === undefined) throw new Error("path.to_windows: requires `value`")
            const result = params.value.replace(/\//g, "\\")
            return done({
              title: `path.to_windows: ${result}`,
              metadata: { action, flavor, result },
              output: result,
            })
          }

          if (action === "split") {
            if (params.value === undefined) throw new Error("path.split: requires `value`")
            const sep = flavor === "win32" ? /[\\/]/ : "/"
            const parts = params.value.split(sep)
            return done({
              title: `path.split: ${parts.length} parts`,
              metadata: { action, flavor, result: parts },
              output: parts.join("\n"),
            })
          }

          if (action === "common_prefix") {
            const parts = params.parts ?? []
            if (parts.length === 0) throw new Error("path.common_prefix: requires `parts`")
            const sep = flavor === "win32" ? "\\" : "/"
            const result = commonPrefix(
              parts.map((s) => (flavor === "win32" ? s.replace(/\//g, "\\") : s)),
              sep,
            )
            return done({
              title: `path.common_prefix: ${result || "(empty)"}`,
              metadata: { action, flavor, result },
              output: result,
            })
          }

          throw new Error(`path: unknown action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  pickFlavor,
  flavorName,
  commonPrefix,
}
