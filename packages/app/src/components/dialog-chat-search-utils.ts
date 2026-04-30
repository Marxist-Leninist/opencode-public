export type ChatSearchHighlightPart = {
  text: string
  match: boolean
}

const CHAT_SEARCH_STOPWORDS = new Set([
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

export function chatSearchQueryTerms(query: string) {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= 2)
  const filtered = terms.filter((term) => !CHAT_SEARCH_STOPWORDS.has(term))
  return filtered.length > 0 ? filtered : terms
}

export function splitChatSearchHighlight(text: string, query: string): ChatSearchHighlightPart[] {
  const terms = chatSearchQueryTerms(query)
  if (terms.length === 0) return [{ text, match: false }]

  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi")
  return text
    .split(pattern)
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      match: terms.includes(part.toLowerCase()),
    }))
}

export function clampChatSearchIndex(index: number, length: number) {
  if (length <= 0) return 0
  return Math.max(0, Math.min(index, length - 1))
}

export function moveChatSearchIndex(index: number, length: number, delta: -1 | 1) {
  return clampChatSearchIndex(index + delta, length)
}

export function parseChatSearchModelSelection(value: string) {
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return
  return { providerID, modelID }
}
