import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/mask"

const { findMatches, applyMatches, placeholderFor, buildEnabled, compileCustom, summarize, DETECTORS, KINDS, luhnValid, looksLikeCard } = __testing

const allEnabled = new Set<string>(KINDS as readonly string[])

describe("tool.mask credit-card detection", () => {
  test("Luhn validation rejects garbage", () => {
    expect(luhnValid("1234567890123456")).toBe(false)
    // Visa test number
    expect(luhnValid("4111111111111111")).toBe(true)
    // Amex test number
    expect(luhnValid("378282246310005")).toBe(true)
  })
  test("looksLikeCard requires a known brand prefix", () => {
    expect(looksLikeCard("4111111111111111")).toBe(true) // Visa
    expect(looksLikeCard("9999999999999999")).toBe(false) // no brand
  })
  test("12-digit run that happens to be Luhn-valid but no brand is rejected", () => {
    expect(looksLikeCard("000000000000")).toBe(false)
  })
})

describe("tool.mask findMatches", () => {
  test("detects email + ipv4 + url + jwt + AWS key", () => {
    const text = [
      "Email me at alice@example.com or visit https://example.org/path?x=1.",
      "Server 10.0.0.1 with token AKIAIOSFODNN7EXAMPLE.",
      "JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ].join("\n")
    const matches = findMatches(text, DETECTORS, allEnabled)
    const kinds = matches.map((m) => String(m.kind))
    expect(kinds).toContain("email")
    expect(kinds).toContain("url")
    expect(kinds).toContain("ipv4")
    expect(kinds).toContain("aws_access_key")
    expect(kinds).toContain("jwt")
  })

  test("Bearer captures token only, not the literal 'Bearer '", () => {
    const text = "Authorization: Bearer abc123def456ghi"
    const matches = findMatches(text, DETECTORS, new Set(["bearer"]))
    expect(matches.length).toBe(1)
    expect(matches[0].value).toBe("abc123def456ghi")
    expect(matches[0].kind).toBe("bearer")
  })

  test("password_query captures the value only", () => {
    const text = "https://x/y?password=hunter2&other=1"
    const matches = findMatches(text, DETECTORS, new Set(["password_query"]))
    expect(matches.length).toBe(1)
    expect(matches[0].value).toBe("hunter2")
  })

  test("password_query wins over enclosing URL with default detectors", () => {
    const text = "https://x/y?password=hunter2&other=1"
    const matches = findMatches(text, DETECTORS, allEnabled)
    expect(matches.map((m) => m.kind)).toEqual(["password_query"])
    expect(applyMatches(text, matches, "placeholder")).toBe("https://x/y?password=[REDACTED:password_query]&other=1")
  })

  test("non-luhn 16-digit numbers are not detected as credit_card", () => {
    const text = "ID: 1234567890123456"
    const matches = findMatches(text, DETECTORS, new Set(["credit_card"]))
    expect(matches.length).toBe(0)
  })

  test("private key block is matched as a single chunk", () => {
    const text = [
      "header",
      "-----BEGIN PRIVATE KEY-----",
      "AAAAAAAA",
      "BBBBBBBB",
      "-----END PRIVATE KEY-----",
      "footer",
    ].join("\n")
    const matches = findMatches(text, DETECTORS, new Set(["private_key_pem"]))
    expect(matches.length).toBe(1)
    expect(matches[0].value.startsWith("-----BEGIN")).toBe(true)
    expect(matches[0].value.endsWith("PRIVATE KEY-----")).toBe(true)
  })

  test("overlap resolution prefers earlier-listed detector", () => {
    // private_key_pem comes before url, so a URL inside a key block wins for the key.
    const text = "-----BEGIN PRIVATE KEY-----\nhttps://x.test\n-----END PRIVATE KEY-----"
    const matches = findMatches(text, DETECTORS, allEnabled)
    expect(matches.length).toBe(1)
    expect(matches[0].kind).toBe("private_key_pem")
  })
})

describe("tool.mask applyMatches placeholders", () => {
  const matches = [{ kind: "email" as string, value: "x@y.com", start: 0, end: 7 }]

  test("placeholder mode", () => {
    expect(applyMatches("x@y.com end", matches, "placeholder")).toBe("[REDACTED:email] end")
  })
  test("delete mode drops the match", () => {
    expect(applyMatches("x@y.com end", matches, "delete")).toBe(" end")
  })
  test("partial keeps first/last 2 chars", () => {
    const out = applyMatches("x@y.com end", matches, "partial")
    expect(out).toBe("x@***om end")
  })
  test("hash mode is stable across runs", () => {
    const a = placeholderFor("email", "alice@example.com", "hash")
    const b = placeholderFor("email", "alice@example.com", "hash")
    expect(a).toBe(b)
    expect(a.startsWith("email-")).toBe(true)
    expect(a.length).toBe("email-".length + 8)
  })
})

describe("tool.mask buildEnabled", () => {
  test("default enables all built-ins", () => {
    const e = buildEnabled({ action: "redact", text: "" } as any, [])
    expect(e.has("email")).toBe(true)
    expect(e.has("phone")).toBe(true)
  })
  test("kinds restricts to the listed set", () => {
    const e = buildEnabled({ action: "redact", text: "", kinds: ["email", "url"] } as any, [])
    expect(e.has("email")).toBe(true)
    expect(e.has("url")).toBe(true)
    expect(e.has("phone")).toBe(false)
  })
  test("exclude removes from defaults", () => {
    const e = buildEnabled({ action: "redact", text: "", exclude: ["phone"] } as any, [])
    expect(e.has("phone")).toBe(false)
    expect(e.has("email")).toBe(true)
  })
})

describe("tool.mask custom detectors", () => {
  test("compileCustom respects flags and 'g' is auto-added", () => {
    const dets = compileCustom([{ name: "ticket", regex: "TICKET-\\d+" }])
    expect(dets[0].pattern.flags).toContain("g")
  })
  test("custom detector matches alongside builtins", () => {
    const customDets = compileCustom([{ name: "ticket", regex: "TICKET-\\d+" }])
    const text = "See TICKET-42 from alice@x.com"
    const matches = findMatches(text, [...DETECTORS, ...customDets], new Set([...allEnabled, "ticket"]))
    const kinds = matches.map((m) => String(m.kind))
    expect(kinds).toContain("ticket")
    expect(kinds).toContain("email")
  })
  test("compileCustom rejects bad flags", () => {
    expect(() => compileCustom([{ name: "x", regex: "a", flags: "z" }])).toThrow(/bad flags/)
  })
  test("compileCustom rejects invalid regex", () => {
    expect(() => compileCustom([{ name: "x", regex: "[" }])).toThrow(/invalid regex/)
  })
})

describe("tool.mask summarize", () => {
  test("counts by kind", () => {
    const m = [
      { kind: "email", value: "a", start: 0, end: 1 },
      { kind: "email", value: "b", start: 2, end: 3 },
      { kind: "url", value: "c", start: 4, end: 5 },
    ] as any
    const s = summarize(m)
    expect(s.total).toBe(3)
    expect(s.by_kind.email).toBe(2)
    expect(s.by_kind.url).toBe(1)
  })
})
