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
const DEFAULT_SEMANTIC_SCAN_LIMIT = 80
const MAX_LIMIT = 50
const MAX_SCAN_LIMIT = 2_000
const MAX_SEMANTIC_CANDIDATES = 30
const MAX_SEMANTIC_HITS = 4
const MAX_PART_TEXT = 10_000
const MAX_RESULT_TEXT = 2_000
const MAX_SNIPPET = 280
const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "do",
  "does",
  "did",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "who",
  "why",
  "with",
  "you",
  "your",
])

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
    rankedCount: z.number().int().min(0).optional(),
    source: z.enum(["classic", "rerank", "semantic"]).optional(),
  })
  export type AugmentResponse = z.infer<typeof AugmentResponse>

  export function normalize(input: string) {
    return input.toLowerCase().replace(/\s+/g, " ").trim()
  }

  export function terms(input: string) {
    const tokens = normalize(input)
      .split(" ")
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
    const filtered = tokens.filter((item) => !SEARCH_STOPWORDS.has(item))
    return filtered.length > 0 ? filtered : tokens
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

  function previewHits(input: {
    message: MessageV2.WithParts
    query: string
    queryTerms: string[]
  }): Hit[] {
    const hits: Hit[] = []
    for (const part of input.message.parts) {
      const raw = partText(part)
      if (!raw) continue

      const text = trimText(raw, MAX_PART_TEXT)
      hits.push({
        messageID: input.message.info.id,
        partID: part.id,
        role: input.message.info.role,
        type: part.type,
        text: truncate(text, MAX_RESULT_TEXT),
        snippet: snippet(text, input.query, input.queryTerms),
        score: 1,
        time: input.message.info.time.created,
      })
    }
    return hits
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

  function buildSemanticContext(results: Result[]) {
    return results.slice(0, MAX_SEMANTIC_CANDIDATES).map((result, index) => ({
      rank: index + 1,
      sessionID: result.session.id,
      title: result.session.title,
      directory: result.session.directory,
      updated: new Date(result.session.time.updated).toISOString(),
      preview: result.hits.slice(0, MAX_SEMANTIC_HITS).map((hit) => ({
        role: hit.role,
        type: hit.type,
        snippet: hit.snippet.slice(0, 500),
      })),
    }))
  }

  function orderedResults(input: {
    candidates: Result[]
    sessionIDs: string[]
    limit: number
    appendRemaining: boolean
  }) {
    const byID = new Map<string, Result>(input.candidates.map((candidate) => [candidate.session.id, candidate]))
    const seen = new Set<string>()
    const ordered: Result[] = []

    for (const sessionID of input.sessionIDs) {
      const candidate = byID.get(sessionID)
      if (!candidate || seen.has(sessionID)) continue
      seen.add(sessionID)
      ordered.push(candidate)
    }

    if (input.appendRemaining) {
      for (const candidate of input.candidates) {
        if (seen.has(candidate.session.id)) continue
        seen.add(candidate.session.id)
        ordered.push(candidate)
      }
    }

    return ordered.slice(0, input.limit)
  }

  function jsonObjectCandidates(text: string) {
    const candidates: string[] = []
    let start = -1
    let depth = 0
    let inString = false
    let escaping = false

    for (let index = 0; index < text.length; index++) {
      const char = text[index]
      if (inString) {
        if (escaping) {
          escaping = false
          continue
        }
        if (char === "\\") {
          escaping = true
          continue
        }
        if (char === '"') inString = false
        continue
      }

      if (char === '"') {
        inString = true
        continue
      }
      if (char === "{") {
        if (depth === 0) start = index
        depth++
        continue
      }
      if (char === "}" && depth > 0) {
        depth--
        if (depth === 0 && start >= 0) {
          candidates.push(text.slice(start, index + 1))
          start = -1
        }
      }
    }

    return candidates
  }

  export function parseSemanticResult(text: string, validIDs: Set<string>) {
    const fallback = text.trim()
    const mentionsID = (source: string, id: string) =>
      new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`).test(source)

    for (const candidate of jsonObjectCandidates(text)) {
      try {
        const parsed = JSON.parse(candidate) as { answer?: unknown; sessionIDs?: unknown }
        const seen = new Set<string>()
        const sessionIDs = Array.isArray(parsed.sessionIDs)
          ? parsed.sessionIDs.filter((item): item is string => {
              if (typeof item !== "string" || !validIDs.has(item) || seen.has(item)) return false
              seen.add(item)
              return true
            })
          : []
        if (sessionIDs.length === 0) {
          for (const id of validIDs) {
            if (!mentionsID(candidate, id) || seen.has(id)) continue
            seen.add(id)
            sessionIDs.push(id)
          }
        }
        return {
          answer: typeof parsed.answer === "string" ? parsed.answer.trim() : fallback,
          sessionIDs,
        }
      } catch {
        continue
      }
    }

    const mentioned = [...validIDs].filter((id) => mentionsID(text, id))
    if (mentioned.length > 0) return { answer: fallback, sessionIDs: mentioned }
    return { answer: fallback, sessionIDs: [] as string[] }
  }

  const semanticCandidates = Effect.fn("SessionSearch.semanticCandidates")(function* (input: Input) {
    const query = input.query.trim()
    const queryTerms = terms(query)
    const scanLimit = Math.min(input.scanLimit ?? DEFAULT_SEMANTIC_SCAN_LIMIT, MAX_SCAN_LIMIT)
    const session = yield* Session.Service

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

    const results: Result[] = []
    for (const item of sessions) {
      if (!input.includeArchived && item.time.archived) continue

      const messages = yield* session.messages({ sessionID: item.id })
      const hits = messages
        .slice()
        .reverse()
        .flatMap((message) => previewHits({ message, query, queryTerms }))
        .slice(0, MAX_SEMANTIC_HITS)

      if (!item.title && hits.length === 0) continue
      results.push({
        session: item,
        score: Math.max(1, scoreText(query, queryTerms, item.title, true)),
        hits,
      })
    }

    return results.slice(0, MAX_SEMANTIC_CANDIDATES)
  })

  type ModelRef = z.infer<typeof Model>
  type RankingMode = "rerank" | "semantic"

  const rankCandidates = Effect.fn("SessionSearch.rankCandidates")(function* (input: {
    query: string
    candidates: Result[]
    model: ModelRef
    mode: RankingMode
  }) {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(input.model.providerID, input.model.modelID)
    const language = yield* provider.getLanguage(model)
    const validIDs = new Set(input.candidates.map((candidate) => candidate.session.id))
    const generated = yield* Effect.tryPromise({
      try: () =>
        generateText({
          model: language,
          temperature: 0,
          maxOutputTokens: 2000,
          messages: [
            {
              role: "system",
              content:
                input.mode === "rerank"
                  ? 'You rerank prior OpenCode chat search results. Use only the provided candidates. Return strict JSON with shape {"answer":"...","sessionIDs":["..."]}. Copy sessionID strings exactly from candidates; do not use ranks, titles, or rewritten IDs. Put the best matching sessions first. Ignore candidates that only match common words like "are", "you", "the", or "what". For conversational queries, include plausible greeting/status/introduction chats even when wording differs. Return empty sessionIDs only when no candidate is plausibly relevant.'
                  : 'You search prior OpenCode chats. Use only the provided candidate previews. Return strict JSON with shape {"answer":"...","sessionIDs":["..."]}. Copy sessionID strings exactly from candidates; do not use ranks, titles, or rewritten IDs. Prefer recall over precision: include any session with a plausible semantic, topical, or conversational connection to the query. For example "hi", "hello", "what up", "what are you doing", "greeting", and "say hello" can match a session titled "Greeting". Order by descending relevance. Return empty sessionIDs only when no candidate has any plausible connection.',
            },
            {
              role: "user",
              content: JSON.stringify({
                query: input.query,
                candidates: buildSemanticContext(input.candidates),
              }),
            },
          ],
        }),
      catch: (cause) => cause,
    })

    return parseSemanticResult(generated.text, validIDs)
  })

  export const augment = Effect.fn("SessionSearch.augment")(function* (input: AugmentInput) {
    const response = yield* search(input)
    const provider = yield* Provider.Service
    const ref = input.model ?? (yield* provider.defaultModel())
    const limit = input.limit ?? DEFAULT_LIMIT

    if (response.results.length > 0) {
      const reranked = yield* rankCandidates({
        query: response.query,
        candidates: response.results,
        model: ref,
        mode: "rerank",
      })

      if (reranked.sessionIDs.length > 0) {
        return {
          query: response.query,
          answer: reranked.answer || "AI reranked the classic search results.",
          model: ref,
          results: orderedResults({
            candidates: response.results,
            sessionIDs: reranked.sessionIDs,
            limit,
            appendRemaining: true,
          }),
          rankedCount: reranked.sessionIDs.length,
          source: "rerank" as const,
        }
      }

      const semanticCandidatesList = yield* semanticCandidates(input)
      if (semanticCandidatesList.length > 0) {
        const semantic = yield* rankCandidates({
          query: response.query,
          candidates: semanticCandidatesList,
          model: ref,
          mode: "semantic",
        })

        if (semantic.sessionIDs.length > 0) {
          return {
            query: response.query,
            answer: semantic.answer || "AI found semantic matches outside the classic ranking.",
            model: ref,
            results: orderedResults({
              candidates: semanticCandidatesList,
              sessionIDs: semantic.sessionIDs,
              limit,
              appendRemaining: false,
            }),
            rankedCount: semantic.sessionIDs.length,
            source: "semantic" as const,
          }
        }
      }

      return {
        query: response.query,
        answer: reranked.answer || "AI did not find a stronger semantic ranking; showing classic search results.",
        model: ref,
        results: response.results,
        rankedCount: 0,
        source: "classic" as const,
      }
    }

    const semanticCandidatesList = yield* semanticCandidates(input)
    if (semanticCandidatesList.length > 0) {
      const semantic = yield* rankCandidates({
        query: response.query,
        candidates: semanticCandidatesList,
        model: ref,
        mode: "semantic",
      })

      return {
        query: response.query,
        answer: semantic.answer || "No matching chats found.",
        model: ref,
        results: orderedResults({
          candidates: semanticCandidatesList,
          sessionIDs: semantic.sessionIDs,
          limit,
          appendRemaining: false,
        }),
        rankedCount: semantic.sessionIDs.length,
        source: semantic.sessionIDs.length > 0 ? ("semantic" as const) : ("classic" as const),
      }
    }

    return {
      query: response.query,
      answer: "No matching chats found.",
      model: ref,
      results: response.results,
      rankedCount: 0,
      source: "classic" as const,
    }
  })
}
