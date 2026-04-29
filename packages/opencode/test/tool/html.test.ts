import { describe, expect, test } from "bun:test"

import { __testing } from "@/tool/html"

const SAMPLE = `<!DOCTYPE html>
<html>
<head>
  <title>Test &amp; Demo</title>
  <meta charset="utf-8">
  <meta name="description" content="A demo page">
  <meta property="og:title" content="OG title">
  <link rel="stylesheet" href="/styles.css">
  <script src="/app.js"></script>
  <script>console.log('inline')</script>
</head>
<body>
  <h1>Top &mdash; heading</h1>
  <p>Hello <a href="/about">About</a> and <a href="https://other.test/x">External</a>.</p>
  <h2 id="about">About</h2>
  <img src="/cat.png" alt="Cat">
  <form action="/submit" method="POST">
    <input type="text" name="q" value="">
    <select name="region"><option>US</option></select>
    <textarea name="msg"></textarea>
    <button type="submit">Send</button>
  </form>
  <noscript>Please enable JS</noscript>
  <style>body { color: red }</style>
</body>
</html>`

describe("html helpers", () => {
  test("decodeEntities decodes named, decimal, hex", () => {
    expect(__testing.decodeEntities("a &amp; b &#65; &#x42;")).toBe("a & b A B")
    expect(__testing.decodeEntities("&unknown;")).toBe("&unknown;")
  })

  test("attrMap parses double, single, unquoted, and bare attrs", () => {
    const a = __testing.attrMap('href="/x" data-id=5 disabled name=\'foo\'')
    expect(a.href).toBe("/x")
    expect(a["data-id"]).toBe("5")
    expect(a.disabled).toBe("")
    expect(a.name).toBe("foo")
  })

  test("htmlToText drops scripts/styles/noscript and decodes entities", () => {
    const text = __testing.htmlToText(SAMPLE)
    expect(text).toContain("Top — heading")
    expect(text).toContain("About")
    expect(text).toContain("External")
    expect(text).not.toContain("console.log")
    expect(text).not.toContain("color: red")
    expect(text).not.toContain("Please enable JS")
  })

  test("extractLinks captures text + href + line", () => {
    const links = __testing.extractLinks(SAMPLE)
    expect(links.length).toBe(2)
    expect(links[0]!.text).toBe("About")
    expect(links[0]!.href).toBe("/about")
    expect(links[1]!.href).toBe("https://other.test/x")
    expect(links[0]!.line).toBeGreaterThan(10)
  })

  test("extractLinks resolves relative URLs and same-host filter", () => {
    const links = __testing.extractLinks(SAMPLE, {
      baseUrl: "https://example.test/page",
      sameHostOnly: true,
    })
    expect(links.length).toBe(1)
    expect(links[0]!.href).toBe("/about")
    expect(links[0]!.resolved).toBe("https://example.test/about")
  })

  test("extractImages returns alt + src", () => {
    const imgs = __testing.extractImages(SAMPLE)
    expect(imgs.length).toBe(1)
    expect(imgs[0]!.alt).toBe("Cat")
    expect(imgs[0]!.src).toBe("/cat.png")
  })

  test("extractScripts splits external + inline", () => {
    const all = __testing.extractScripts(SAMPLE, { includeInline: true })
    const ext = all.filter((s) => s.src)
    const inl = all.filter((s) => s.inline)
    expect(ext.length).toBe(1)
    expect(ext[0]!.src).toBe("/app.js")
    expect(inl.length).toBe(1)
    expect(inl[0]!.inline).toContain("inline")

    const onlyExt = __testing.extractScripts(SAMPLE, { includeInline: false })
    expect(onlyExt.length).toBe(1)
  })

  test("extractStylesheets only returns rel=stylesheet", () => {
    const ss = __testing.extractStylesheets(SAMPLE)
    expect(ss.length).toBe(1)
    expect(ss[0]!.href).toBe("/styles.css")
  })

  test("extractMeta includes title and known meta keys", () => {
    const metas = __testing.extractMeta(SAMPLE)
    const titleMeta = metas.find((m) => m.name === "title")
    expect(titleMeta?.content).toBe("Test & Demo")
    expect(metas.find((m) => m.charset === "utf-8")).toBeDefined()
    expect(metas.find((m) => m.name === "description")?.content).toBe("A demo page")
    expect(metas.find((m) => m.property === "og:title")?.content).toBe("OG title")
  })

  test("extractHeadings finds h1 + h2 with text", () => {
    const hs = __testing.extractHeadings(SAMPLE)
    expect(hs.length).toBe(2)
    expect(hs[0]!.level).toBe(1)
    expect(hs[0]!.text).toBe("Top — heading")
    expect(hs[1]!.level).toBe(2)
    expect(hs[1]!.text).toBe("About")
  })

  test("extractForms returns action/method and controls", () => {
    const forms = __testing.extractForms(SAMPLE)
    expect(forms.length).toBe(1)
    expect(forms[0]!.action).toBe("/submit")
    expect(forms[0]!.method).toBe("POST")
    const tags = forms[0]!.controls.map((c) => c.tag).sort()
    expect(tags).toEqual(["button", "input", "select", "textarea"])
  })

  test("findElements filters by tag/id/class", () => {
    const byId = __testing.findElements(SAMPLE, { id: "about" })
    expect(byId.length).toBe(1)
    expect(byId[0]!.tag).toBe("h2")

    const byTag = __testing.findElements(SAMPLE, { tag: "a" })
    expect(byTag.length).toBe(2)

    const byClass = __testing.findElements(SAMPLE, { class: "missing" })
    expect(byClass.length).toBe(0)
  })

  test("resolveUrl returns undefined when no base", () => {
    expect(__testing.resolveUrl("/x")).toBeUndefined()
    expect(__testing.resolveUrl("/x", "https://a.test")).toBe("https://a.test/x")
  })
})
