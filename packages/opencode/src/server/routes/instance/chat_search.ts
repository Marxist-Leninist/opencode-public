import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Effect } from "effect"
import z from "zod"
import { Session } from "@/session"
import { Provider } from "@/provider"
import { Log } from "@/util"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"
import { errors } from "../../error"
import { generateText } from "ai"

const log = Log.create({ service: "chat-search" })

// Soft caps to keep classical search fast and AI search cheap.
const MAX_SESSIONS_SCANNED = 200
const MAX_MESSAGES_PER_SESSION = 200
const SNIPPET_RADIUS = 80
const AI_MAX_SESSIONS = 60
const AI_MAX_TITLE_CHARS = 120
const AI_MAX_PREVIEW_CHARS = 320

type Hit = {
  id: string
  title: string
  directory?: string
  snippet?: string
  score: number
  why?: string
  matched_at?: number
  matched_role?: "user" | "assistant"
}

const Body = z.object({
  query: z.string().trim().min(1).max(500),
  mode: z.enum(["classical", "ai"]),
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  directory: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  case_sensitive: z.coerce.boolean().optional().default(false),
  regex: z.coerce.boolean().optional().default(false),
})

const Response = z.object({
  hits: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      directory: z.string().optional(),
      snippet: z.string().optional(),
      score: z.number(),
      why: z.string().optional(),
      matched_at: z.number().optional(),
      matched_role: z.enum(["user", "assistant"]).optional(),
    }),
  ),
  mode: z.enum(["classical", "ai"]),
  elapsed_ms: z.number(),
  scanned: z.number(),
  truncated: z.boolean(),
})

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  const out: string[] = []
  for (const p of parts) {
    if (!p || typeof p !== "object") continue
    const part = p as Record<string, unknown>
    if (part.type === "text" && typeof part.text === "string") {
      out.push(part.text)
    } else if (part.type === "reasoning" && typeof part.text === "string") {
      // Skip reasoning by default — usually noisy and big.
    } else if (part.type === "tool" && typeof part.tool === "string") {
      // Surface tool name + small input/output text for searchability.
      const state = part.state as Record<string, unknown> | undefined
      if (state) {
        const inp = state.input
        const out_ = state.output
        if (typeof inp === "string") out.push(inp)
        if (typeof out_ === "string") out.push(out_)
      }
    }
  }
  return out.join("\n")
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS)
  let s = text.slice(start, end).replace(/\s+/g, " ").trim()
  if (start > 0) s = "…" + s
  if (end < text.length) s = s + "…"
  return s
}

function classicalScore(matches: number, total: number): number {
  // Logarithmic so 1 match still ranks reasonably; many matches climb gracefully.
  if (matches <= 0) return 0
  const density = total > 0 ? matches / Math.max(1, total / 800) : matches
  return Math.min(1, 0.4 + Math.log10(1 + matches) * 0.25 + Math.min(0.35, density * 0.1))
}

export const ChatSearchRoutes = lazy(() =>
  new Hono().post(
    "/",
    describeRoute({
      summary: "Search chats (classical or AI-augmented)",
      description:
        "Search across all chat sessions. Mode 'classical' does literal/regex text matching across messages with snippets. Mode 'ai' asks a model to rank session relevance by title + first user message.",
      operationId: "chatSearch.run",
      responses: {
        200: {
          description: "Search results",
          content: { "application/json": { schema: resolver(Response) } },
        },
        ...errors(400),
      },
    }),
    validator("json", Body),
    async (c) =>
      jsonRequest("ChatSearchRoutes.run", c, function* () {
        const body = c.req.valid("json")
        const start = Date.now()

        // Build the predicate up front. Regex compiles once.
        let test: (text: string) => Array<{ index: number; length: number }>
        if (body.regex) {
          let re: RegExp
          try {
            re = new RegExp(body.query, body.case_sensitive ? "g" : "gi")
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`invalid regex: ${msg}`)
          }
          test = (text) => {
            const out: Array<{ index: number; length: number }> = []
            let m: RegExpExecArray | null
            re.lastIndex = 0
            while ((m = re.exec(text)) !== null) {
              out.push({ index: m.index, length: m[0].length })
              if (m[0].length === 0) re.lastIndex++
              if (out.length >= 64) break
            }
            return out
          }
        } else {
          const needle = body.case_sensitive ? body.query : body.query.toLowerCase()
          test = (text) => {
            const hay = body.case_sensitive ? text : text.toLowerCase()
            const out: Array<{ index: number; length: number }> = []
            let from = 0
            while (true) {
              const i = hay.indexOf(needle, from)
              if (i === -1) break
              out.push({ index: i, length: needle.length })
              from = i + Math.max(1, needle.length)
              if (out.length >= 64) break
            }
            return out
          }
        }

        // Collect session summaries up to the cap. Wrap the async iterator in
        // a Promise so we can use it from inside the Effect.gen generator.
        const summaries = yield* Effect.promise(async () => {
          const out: Array<{ id: string; title: string; directory: string; updated?: number }> = []
          for await (const s of Session.list({
            directory: body.directory,
            roots: true,
            limit: MAX_SESSIONS_SCANNED,
          })) {
            if (!s?.id) continue
            out.push({
              id: s.id,
              title: s.title ?? "(untitled)",
              directory: (s as { directory?: string }).directory ?? body.directory ?? "",
              updated: s.time?.updated,
            })
            if (out.length >= MAX_SESSIONS_SCANNED) break
          }
          return out
        })
        const scanned = summaries.length

        const sessionService = yield* Session.Service

        if (body.mode === "classical") {
          const hits: Hit[] = []
          for (const s of summaries) {
            // First test the title cheaply.
            const titleHits = test(s.title)
            // Then fetch messages and scan their text bodies.
            const msgs = yield* sessionService
              .messages({ sessionID: s.id as never })
              .pipe(Effect.catch(() => Effect.succeed([])))
            const messages = msgs.slice(-MAX_MESSAGES_PER_SESSION)

            let totalText = 0
            let totalMatches = 0
            let bestSnippet: string | undefined
            let bestSnippetWhen: number | undefined
            let bestSnippetRole: "user" | "assistant" | undefined

            for (const m of messages) {
              const role = m.info.role === "user" || m.info.role === "assistant" ? m.info.role : undefined
              const text = extractText((m as { parts?: unknown }).parts)
              if (!text) continue
              totalText += text.length
              const ms = test(text)
              if (ms.length) {
                totalMatches += ms.length
                if (!bestSnippet) {
                  bestSnippet = snippetAround(text, ms[0].index, ms[0].length)
                  bestSnippetWhen = (m.info as { time?: { created?: number } }).time?.created
                  bestSnippetRole = role
                }
              }
            }

            if (titleHits.length > 0 && !bestSnippet) {
              bestSnippet = snippetAround(s.title, titleHits[0].index, titleHits[0].length)
            }

            const matches = titleHits.length + totalMatches
            if (matches > 0) {
              hits.push({
                id: s.id,
                title: s.title,
                directory: s.directory,
                snippet: bestSnippet,
                score: classicalScore(matches, totalText),
                matched_at: bestSnippetWhen,
                matched_role: bestSnippetRole,
              })
            }
          }
          hits.sort((a, b) => b.score - a.score || (b.matched_at ?? 0) - (a.matched_at ?? 0))
          const trimmed = hits.slice(0, body.limit)
          return {
            hits: trimmed,
            mode: "classical" as const,
            elapsed_ms: Date.now() - start,
            scanned,
            truncated: hits.length > body.limit,
          }
        }

        // AI-augmented mode.
        if (!body.providerID || !body.modelID) {
          throw new Error("ai mode requires providerID and modelID")
        }
        const provider = yield* Provider.Service
        const model = yield* provider
          .getModel(body.providerID as never, body.modelID as never)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!model) {
          throw new Error(`unable to load model ${body.providerID}/${body.modelID}`)
        }
        const language = yield* provider
          .getLanguage(model)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!language) {
          throw new Error(`unable to resolve language model for ${body.providerID}/${body.modelID}`)
        }

        // Pull a one-line preview from each session: first user message text.
        const previews: Array<{ id: string; title: string; preview: string }> = []
        for (const s of summaries.slice(0, AI_MAX_SESSIONS)) {
          const msgs = yield* sessionService
            .messages({ sessionID: s.id as never })
            .pipe(Effect.catch(() => Effect.succeed([])))
          const first = msgs.find((m) => m.info.role === "user")
          const preview = first ? extractText((first as { parts?: unknown }).parts) : ""
          previews.push({
            id: s.id,
            title: s.title.slice(0, AI_MAX_TITLE_CHARS),
            preview: preview.replace(/\s+/g, " ").trim().slice(0, AI_MAX_PREVIEW_CHARS),
          })
        }

        const userPrompt = [
          `Search query: ${body.query}`,
          "",
          "Sessions to rank:",
          ...previews.map((p, i) => `[${i + 1}] id=${p.id} title="${p.title}" preview="${p.preview}"`),
          "",
          'Return ONLY a strict JSON array, no prose, no markdown fence. Each entry: {"id": "<session id>", "score": <0..1>, "why": "<one short sentence>"}. Include only sessions actually relevant. Sort by score desc.',
        ].join("\n")

        let raw = ""
        try {
          const result = yield* Effect.promise(async () => {
            const resp = await generateText({
              model: language as never,
              prompt: userPrompt,
              system:
                "You rank chat sessions by relevance to a user's query. Output strict JSON only — no prose, no markdown.",
              temperature: 0.1,
              maxRetries: 1,
            } as never)
            return resp
          })
          raw = (result as { text?: string }).text ?? ""
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn("ai search call failed", { msg })
          throw new Error(`ai search call failed: ${msg}`)
        }

        // Tolerant JSON extraction: model might wrap in fences.
        const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
        let parsed: Array<{ id: string; score: number; why?: string }> = []
        try {
          const j = JSON.parse(trimmed)
          if (Array.isArray(j)) parsed = j as typeof parsed
        } catch {
          // Try to find a JSON array substring.
          const open = trimmed.indexOf("[")
          const close = trimmed.lastIndexOf("]")
          if (open !== -1 && close !== -1 && close > open) {
            try {
              const j = JSON.parse(trimmed.slice(open, close + 1))
              if (Array.isArray(j)) parsed = j as typeof parsed
            } catch {}
          }
        }

        const byId = new Map(previews.map((p) => [p.id, p]))
        const hits: Hit[] = parsed
          .filter((p) => byId.has(p.id) && typeof p.score === "number")
          .map((p) => {
            const s = byId.get(p.id)!
            return {
              id: p.id,
              title: s.title,
              directory: summaries.find((x) => x.id === p.id)?.directory,
              snippet: s.preview,
              score: Math.max(0, Math.min(1, p.score)),
              why: typeof p.why === "string" ? p.why.slice(0, 240) : undefined,
            }
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, body.limit)

        return {
          hits,
          mode: "ai" as const,
          elapsed_ms: Date.now() - start,
          scanned,
          truncated: parsed.length > body.limit,
        }
      }),
  ),
)
