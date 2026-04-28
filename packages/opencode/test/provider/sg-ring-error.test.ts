import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { parseAPICallError } from "../../src/provider/error"
import { ProviderID } from "../../src/provider/schema"

function buildAPICallError(body: unknown, status = 502, message = "API error") {
  const responseBody = typeof body === "string" ? body : JSON.stringify(body)
  return new APICallError({
    message,
    url: "https://doxx.lat/ring/v1/chat/completions",
    requestBodyValues: {},
    statusCode: status,
    responseHeaders: { "content-type": "application/json" },
    responseBody,
    cause: undefined,
    isRetryable: true,
  })
}

describe("provider/sg-ring error rewriting", () => {
  test("rewrites ling_session_expired to actionable instructions", () => {
    const err = buildAPICallError({
      error: {
        message:
          "Ling Studio returned an HTML/Alipay verification page; COOKIES + DID_TOKEN in /root/ling_proxy.py need refreshing from a fresh browser login at https://lingstudio.tbox.cn",
        type: "ling_session_expired",
        code: "session_expired",
      },
    })
    const parsed = parseAPICallError({ providerID: ProviderID.make("sg-ring"), error: err })
    expect(parsed.type).toBe("api_error")
    if (parsed.type !== "api_error") return
    expect(parsed.isRetryable).toBe(false)
    expect(parsed.message).toContain("Ring 2.5 1T proxy session expired")
    expect(parsed.message).toContain("lingstudio.tbox.cn")
    expect(parsed.message).toContain("DID_TOKEN")
  })

  test("rewrites session_expired even when only the body code is present", () => {
    const err = buildAPICallError({
      error: { message: "session has expired", code: "session_expired" },
    })
    const parsed = parseAPICallError({ providerID: ProviderID.make("ring"), error: err })
    expect(parsed.type).toBe("api_error")
    if (parsed.type !== "api_error") return
    expect(parsed.message).toContain("Ring 2.5 1T proxy session expired")
    expect(parsed.isRetryable).toBe(false)
  })

  test("non-ring providers are not rewritten", () => {
    const err = buildAPICallError({
      error: { message: "session has expired", code: "session_expired" },
    })
    const parsed = parseAPICallError({ providerID: ProviderID.make("openai"), error: err })
    expect(parsed.type).toBe("api_error")
    if (parsed.type !== "api_error") return
    expect(parsed.message).not.toContain("Ring 2.5 1T proxy session expired")
  })

  test("network unreachable surfaces ssh / proxy diagnostic hint", () => {
    const err = buildAPICallError({ error: { message: "fetch failed: ECONNREFUSED" } }, 0, "fetch failed")
    const parsed = parseAPICallError({ providerID: ProviderID.make("sg-ring"), error: err })
    expect(parsed.type).toBe("api_error")
    if (parsed.type !== "api_error") return
    expect(parsed.message).toContain("Ring 2.5 1T proxy is unreachable")
    expect(parsed.message).toContain("ling_proxy")
  })

  test("502 from nginx upstream is rewritten and marked retryable", () => {
    const err = buildAPICallError({ error: { message: "upstream timeout" } }, 502, "Bad Gateway")
    const parsed = parseAPICallError({ providerID: ProviderID.make("sg-ring"), error: err })
    expect(parsed.type).toBe("api_error")
    if (parsed.type !== "api_error") return
    expect(parsed.message).toContain("nginx upstream gateway error")
    expect(parsed.message).toContain("502")
    expect(parsed.isRetryable).toBe(true)
  })

  test("429 rate limit is rewritten with backoff hint and retryable", () => {
    const err = buildAPICallError({ error: { message: "rate limit", code: "rate_limit_exceeded" } }, 429, "Too Many Requests")
    const parsed = parseAPICallError({ providerID: ProviderID.make("sg-ring"), error: err })
    expect(parsed.type).toBe("api_error")
    if (parsed.type !== "api_error") return
    expect(parsed.message).toContain("rate-limited")
    expect(parsed.isRetryable).toBe(true)
  })

  test("401 surfaces a bearer-token hint and is not retryable", () => {
    const err = buildAPICallError({ error: { message: "missing key" } }, 401, "Unauthorized")
    const parsed = parseAPICallError({ providerID: ProviderID.make("sg-ring"), error: err })
    expect(parsed.type).toBe("api_error")
    if (parsed.type !== "api_error") return
    expect(parsed.message).toContain("rejected the bearer token")
    expect(parsed.message).toContain("PROXY_KEY")
    expect(parsed.isRetryable).toBe(false)
  })

  test("non-expiry ring errors are not rewritten", () => {
    const err = buildAPICallError({ error: { message: "boom", code: "internal_error" } }, 500, "API error")
    const parsed = parseAPICallError({ providerID: ProviderID.make("sg-ring"), error: err })
    expect(parsed.type).toBe("api_error")
    if (parsed.type !== "api_error") return
    expect(parsed.message).not.toContain("Ring 2.5 1T proxy session expired")
    expect(parsed.message).not.toContain("nginx upstream gateway")
  })
})
