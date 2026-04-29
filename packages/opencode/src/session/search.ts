import { generateText } from "ai"
import z from "zod"
import { Effect } from "effect"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Provider } from "@/provider"

const DEFAULT_LIMIT = 20
const DEFAULT_SCAN_LIMIT = 500
const MAX_LIMIT = 50
const MAX_SCAN_LIMIT = 2_000
const MAX_PART_TEXT = 10_000
const MAX_RESULT_TEXT = 2_000
const MAX_SNIPPET = 280

export namespace SessionSearch {
  export const Input = z.object({
    query: z.string().trim().min(1).max(500),
    directory: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
    scanLimit: z.coerce.number().int().min(1).max(MAX_SCAN_LIMIT).optional(),
    includeArchived: z.coerce.boolean().optional(),
  })
  export type Input = z.infer<typeof Input>

  const Model = z.object({
    providerID: ProviderID.zod,
    modelID: ModelID.zod,
  })

  export const AugmentInput = Input.extend({
    model: Model.optional(),
  })
  export type AugmentInput = z.infer<typeof AugmentInput>

  export const Hit = z.object({
    messageID: MessageID.zod,
    partID: PartID.zod.optional(),
    role: z.enum(["user", "assistant"]),
    type: z.string(),
    text: z.string(),
    snippet: z.string(),
    score: z.number(),
    time: z.number().optional(),
  })
  export type Hit = z.infer<typeof Hit>

  export const Result = z.object({
    session: Session.Info.zod,
    score: z.number(),
    hits: z.array(Hit),
  })
  export type Result = z.infer<typeof Result>

  export const Response = z.object({
    query: z.string(),
    results: z.array(Result),
  })
  export type Response = z.infer<typeof Response>

  export const AugmentResponse = z.object({
    query: z.string(),
    answer: z.string(),
    model: Model,
    results: z.array(Result),
  })
  export type AugmentResponse = z.infer<typeof AugmentResponse>

  export function normalize(input: string) {
    return input.toLowerCase().replace(/\s+/g, " ").trim()
  }

  export function terms(input: string) {
    return normalize(input)
      .split(" ")
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
  }

  function trimText(input: string, max: number) {
    const text = input.replace(/\s+/g, " ").trim()
    if (text.length <= max) return text
    return text.slice(0, max).trimEnd()
  }

  function truncate(input: string, max: number) {
    if (input.length <= max) return input
    return `${input.slice(0, max).trimEnd()}...`
  }

  export function scoreText(query: string, queryTerms: string[], text: string, title = false) {
    const haystack = normalize(text)
    if (!haystack) return 0

    const normalizedQuery = normalize(query)
    let score = 0
    const exact = haystack.indexOf(normalizedQuery)
    if (exact >= 0) score += title ? 80 : 30

    for (const term of queryTerms) {
      let index = haystack.indexOf(term)
      while (index >= 0) {
        score += title ? 12 : 5
        index = haystack.indexOf(term, index + term.length)
      }
    }

    if (haystack.startsWith(normalizedQuery)) score += title ? 40 : 8
    return score
  }

  export function snippet(text: string, query: string, queryTerms: string[]) {
    const source = trimText(text, MAX_PART_TEXT)
    const normalized = normalize(source)
    const normalizedQuery = normalize(query)
    let index = normalized.indexOf(normalizedQuery)
    if (index < 0) {
      for (const term of queryTerms) {
        index = normalized.indexOf(term)
        if (index >= 0) break
      }
    }
    if (index < 0) return truncate(source, MAX_SNIPPET)

    const start = Math.max(0, index - 90)
    const end = Math.min(source.length, index + MAX_SNIPPET - 70)
    const prefix = start > 0 ? "..." : ""
    const suffix = end < source.length ? "..." : ""
    return `${prefix}${source.slice(start, end).trim()}${suffix}`
  }

  function partText(part: MessageV2.Part) {
    switch (part.type) {
      case "text":
      case "reasoning":
        return part.text
      case "subtask":
        return `${part.description}\n${part.prompt}`
      case "agent":
        return [part.name, part.source?.value].filter(Boolean).join("\n")
      case "file":
        return [part.filename, part.source?.type, part.source?.text.value, part.source && "path" in part.source ? part.source.path : undefined]
          .filter(Boolean)
          .join("\n")
      case "tool": {
        const state = part.state
        if (state.status === "completed") return [state.title, state.output].filter(Boolean).join("\n")
        if (state.status === "running") return [part.tool, state.title].filter(Boolean).join("\n")
        if (state.status === "error") return [part.tool, state.error].filter(Boolean).join("\n")
        return part.tool
      }
      default:
        return ""
    }
  }

  function messageHits(input: {
    message: MessageV2.WithParts
    query: string
    queryTerms: string[]
  }): Hit[] {
    const hits: Hit[] = []
    for (const part of input.message.parts) {
      const raw = partText(part)
      if (!raw) continue

      const text = trimText(raw, MAX_PART_TEXT)
      const score = scoreText(input.query, input.queryTerms, text)
      if (score <= 0) continue

      hits.push({
        messageID: input.message.info.id,
        partID: part.id,
        role: input.message.info.role,
        type: part.type,
        text: truncate(text, MAX_RESULT_TEXT),
        snippet: snippet(text, input.query, input.queryTerms),
        score,
        time: input.message.info.time.created,
      })
    }
    return hits.sort((a, b) => b.score - a.score)
  }

  export const search = Effect.fn("SessionSearch.search")(function* (input: Input) {
    const query = input.query.trim()
    const queryTerms = terms(query)
    const limit = input.limit ?? DEFAULT_LIMIT
    const scanLimit = input.scanLimit ?? Math.min(MAX_SCAN_LIMIT, Math.max(DEFAULT_SCAN_LIMIT, limit * 30))
    const session = yield* Session.Service

    const results: Result[] = []
    const sessions = yield* Effect.promise(async () => {
      const out: Session.Info[] = []
      for await (const item of Session.list({
        directory: input.directory,
        limit: scanLimit,
      })) {
        out.push(item)
      }
      return out
    })
    for (const item of sessions) {
      if (!input.includeArchived && item.time.archived) continue

      const titleScore = scoreText(query, queryTerms, item.title, true)
      const messages = yield* session.messages({ sessionID: item.id })
      const hits = messages.flatMap((message) => messageHits({ message, query, queryTerms })).slice(0, 8)
      const score = titleScore + hits.reduce((sum, hit) => sum + hit.score, 0)
      if (score <= 0) continue

      results.push({
        session: item,
        score,
        hits,
      })
    }

    results.sort((a, b) => b.score - a.score || b.session.time.updated - a.session.time.updated)
    return {
      query,
      results: results.slice(0, limit),
    }
  })

  function buildContext(results: Result[]) {
    return results.slice(0, 10).map((result, index) => ({
      rank: index + 1,
      sessionID: result.session.id,
      title: result.session.title,
      directory: result.session.directory,
      updated: new Date(result.session.time.updated).toISOString(),
      hits: result.hits.slice(0, 4).map((hit) => ({
        role: hit.role,
        type: hit.type,
        snippet: hit.snippet.slice(0, 500),
      })),
    }))
  }

  export const augment = Effect.fn("SessionSearch.augment")(function* (input: AugmentInput) {
    const response = yield* search(input)
    const provider = yield* Provider.Service
    const ref = input.model ?? (yield* provider.defaultModel())

    if (response.results.length === 0) {
      return {
        query: response.query,
        answer: "No matching chats found.",
        model: ref,
        results: response.results,
      }
    }

    const model = yield* provider.getModel(ref.providerID, ref.modelID)
    const language = yield* provider.getLanguage(model)
    const generated = yield* Effect.tryPromise({
      try: () =>
        generateText({
          model: language,
          temperature: 0,
          maxOutputTokens: 700,
          messages: [
            {
              role: "system",
              content:
                "You search prior OpenCode chats. Answer only from the provided search hits. Be concise, cite session titles when useful, and say when the hits do not contain enough evidence.",
            },
            {
              role: "user",
              content: JSON.stringify({
                query: response.query,
                results: buildContext(response.results),
              }),
            },
          ],
        }),
      catch: (cause) => cause,
    })

    return {
      query: response.query,
      answer: generated.text.trim(),
      model: ref,
      results: response.results,
    }
  })
}
