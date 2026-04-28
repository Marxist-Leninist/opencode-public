import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderID } from "./schema"

// Adapted from overflow detection patterns in:
// https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/overflow.ts
const OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions + Responses API message text)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter, DeepSeek, vLLM
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding, Moonshot
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /request entity too large/i, // HTTP 413
  /context length is only \d+ tokens/i, // vLLM
  /input length.*exceeds.*context length/i, // vLLM
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /too large for model with \d+ maximum context length/i, // Mistral
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
]

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function isOverflow(message: string) {
  if (OVERFLOW_PATTERNS.some((p) => p.test(message))) return true

  // Providers/status patterns handled outside of regex list:
  // - Cerebras: often returns "400 (no body)" / "413 (no body)"
  // - Mistral: often returns "400 (no body)" / "413 (no body)"
  return /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)
}

function message(providerID: ProviderID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const raw = json(input)
  const body = typeof raw?.message === "string" ? (json(raw.message) ?? raw) : raw
  if (!body) return

  const responseBody = JSON.stringify(body)
  if (body.type !== "error") return

  switch (body?.error?.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
    case "server_error":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Server error.",
        isRetryable: true,
        responseBody,
      }
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

function isSgRingProvider(providerID: ProviderID) {
  const id = String(providerID).toLowerCase()
  return id === "sg-ring" || id === "ring" || id.startsWith("sg-ring/")
}

type SgRingRewrite = { message: string; isRetryable: boolean }

function rewriteSgRingMessage(
  originalMessage: string,
  body: any,
  status?: number,
): SgRingRewrite | undefined {
  const errType =
    typeof body?.error?.type === "string" ? body.error.type : typeof body?.type === "string" ? body.type : undefined
  const errCode =
    typeof body?.error?.code === "string" ? body.error.code : typeof body?.code === "string" ? body.code : undefined
  const inner = typeof body?.error?.message === "string" ? body.error.message : undefined
  const haystack = `${originalMessage} ${inner ?? ""}`.toLowerCase()

  const looksLikeExpiry =
    errType === "ling_session_expired" ||
    errCode === "session_expired" ||
    haystack.includes("alipay verification") ||
    haystack.includes("ling studio") ||
    haystack.includes("html/alipay") ||
    haystack.includes("did_token")
  if (looksLikeExpiry) {
    return {
      message: [
        "Ring 2.5 1T proxy session expired.",
        "The upstream Ling Studio (Alipay-protected) requires fresh cookies + DID_TOKEN.",
        "Refresh by signing in at https://lingstudio.tbox.cn in a real browser, then update COOKIES + DID_TOKEN in /root/ling_proxy.py on the SG host and restart the proxy.",
        inner ? `(proxy detail: ${inner})` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
      isRetryable: false,
    }
  }

  // Network-level reachability problems: doxx.lat or the SG host itself is down.
  const looksUnreachable =
    /econn(refused|reset|aborted)/i.test(haystack) ||
    /etimedout|esockettimedout/i.test(haystack) ||
    /enotfound|eai_again/i.test(haystack) ||
    /fetch failed/i.test(haystack) ||
    /socket hang up/i.test(haystack) ||
    /network error/i.test(haystack)
  if (looksUnreachable) {
    return {
      message: [
        "Ring 2.5 1T proxy is unreachable from this host.",
        "Either doxx.lat is offline or the SG host's ling_proxy.py is not running.",
        "Check: `curl -sS https://doxx.lat/ring/v1/models` from this host, then `ssh goddess-mcp` and `systemctl status ling-proxy` (or `ps -ef | grep ling_proxy`).",
        inner ? `(proxy detail: ${inner})` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
      isRetryable: false,
    }
  }

  // Bad gateway / upstream gateway errors from nginx in front of the proxy.
  if (status === 502 || status === 503 || status === 504) {
    return {
      message: [
        `Ring 2.5 1T proxy returned ${status} (nginx upstream gateway error).`,
        "The proxy on goddess-mcp likely crashed, is restarting, or the upstream Ling Studio session is broken.",
        "Try: `ssh goddess-mcp 'systemctl restart ling-proxy'` or restart the proxy script. If it persists, refresh COOKIES + DID_TOKEN in /root/ling_proxy.py.",
        inner ? `(proxy detail: ${inner})` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
      isRetryable: true,
    }
  }

  // Rate limiting at the proxy or upstream Ring.
  if (status === 429 || errCode === "rate_limit_exceeded" || haystack.includes("rate limit")) {
    return {
      message: [
        "Ring 2.5 1T proxy is rate-limited.",
        "Back off for a few seconds and retry, or reduce concurrency. The upstream Ling Studio API has aggressive rate limits.",
        inner ? `(proxy detail: ${inner})` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
      isRetryable: true,
    }
  }

  // Auth-key issues (proxy itself uses a bearer; this is *not* the Alipay session).
  if (status === 401 || status === 403) {
    return {
      message: [
        `Ring 2.5 1T proxy rejected the bearer token (${status}).`,
        "Check {file:sg_ring_key} in your OpenCode config matches the proxy's PROXY_KEY env var on goddess-mcp.",
        inner ? `(proxy detail: ${inner})` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
      isRetryable: false,
    }
  }

  return undefined
}

export function parseAPICallError(input: { providerID: ProviderID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.responseBody)
  if (isOverflow(m) || input.error.statusCode === 413 || body?.error?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined

  if (isSgRingProvider(input.providerID)) {
    const rewritten = rewriteSgRingMessage(m, body, input.error.statusCode)
    if (rewritten) {
      return {
        type: "api_error",
        message: rewritten.message,
        statusCode: input.error.statusCode,
        isRetryable: rewritten.isRetryable,
        responseHeaders: input.error.responseHeaders,
        responseBody: input.error.responseBody,
        metadata,
      }
    }
  }

  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}
