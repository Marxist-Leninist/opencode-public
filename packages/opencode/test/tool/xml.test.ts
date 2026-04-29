import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/xml"

const { parseXml, stringifyXml, decodeEntities, encodeEntities } = __testing

describe("xml.parse", () => {
  test("simple text element", () => {
    expect(parseXml("<a>hi</a>")).toEqual({ a: "hi" })
  })

  test("attributes get prefixed", () => {
    expect(parseXml('<a x="1" y="2"/>')).toEqual({ a: { "@x": "1", "@y": "2" } })
  })

  test("repeated children become arrays", () => {
    expect(parseXml("<root><b>1</b><b>2</b></root>")).toEqual({ root: { b: ["1", "2"] } })
  })

  test("mixed content uses #text", () => {
    expect(parseXml("<a>hi <b>there</b></a>")).toEqual({ a: { b: "there", "#text": "hi" } })
  })

  test("decodes entities", () => {
    expect(parseXml("<a>&amp;&lt;&gt;&quot;&apos;</a>")).toEqual({ a: `&<>"'` })
    expect(parseXml("<a>&#65;&#x42;</a>")).toEqual({ a: "AB" })
  })

  test("CDATA is unwrapped", () => {
    expect(parseXml("<a><![CDATA[<not a tag>]]></a>")).toEqual({ a: "<not a tag>" })
  })

  test("comments are stripped", () => {
    expect(parseXml("<a><!-- x --><b>1</b></a>")).toEqual({ a: { b: "1" } })
  })

  test("XML declaration is tolerated", () => {
    expect(parseXml('<?xml version="1.0"?><a>1</a>')).toEqual({ a: "1" })
  })

  test("self-closing tags", () => {
    expect(parseXml("<a><b/><c/></a>")).toEqual({ a: { b: "", c: "" } })
  })

  test("attribute prefix is configurable", () => {
    expect(parseXml('<a x="1"/>', { attributePrefix: "$", textKey: "_" })).toEqual({ a: { $x: "1" } })
  })

  test("RSS-ish feed", () => {
    const xml = `<rss version="2.0"><channel><title>News</title><item><title>One</title></item><item><title>Two</title></item></channel></rss>`
    const got = parseXml(xml) as any
    expect(got.rss["@version"]).toBe("2.0")
    expect(got.rss.channel.title).toBe("News")
    expect(got.rss.channel.item.length).toBe(2)
    expect(got.rss.channel.item[0].title).toBe("One")
  })

  test("unclosed tag rejected", () => {
    expect(() => parseXml("<a><b></a>")).toThrow()
  })

  test("multiple roots rejected", () => {
    expect(() => parseXml("<a/><b/>")).toThrow()
  })

  test("attribute with > inside quotes parses", () => {
    expect(parseXml('<a x="a>b" y="c"/>')).toEqual({ a: { "@x": "a>b", "@y": "c" } })
  })

  test("BOM is tolerated", () => {
    expect(parseXml("﻿<a/>")).toEqual({ a: "" })
  })
})

describe("xml.stringify", () => {
  test("simple object", () => {
    const out = stringifyXml({ a: "hi" }, { attributePrefix: "@", textKey: "#text", pretty: false, declaration: false })
    expect(out).toBe("<a>hi</a>")
  })

  test("attributes prefixed by @", () => {
    const out = stringifyXml(
      { a: { "@x": "1", "@y": "2" } },
      { attributePrefix: "@", textKey: "#text", pretty: false, declaration: false },
    )
    expect(out).toBe('<a x="1" y="2"/>')
  })

  test("array becomes repeated tags", () => {
    const out = stringifyXml(
      { root: { b: [1, 2, 3] } },
      { attributePrefix: "@", textKey: "#text", pretty: false, declaration: false },
    )
    expect(out).toBe("<root><b>1</b><b>2</b><b>3</b></root>")
  })

  test("declaration prefix when enabled", () => {
    const out = stringifyXml(
      { a: "" },
      { attributePrefix: "@", textKey: "#text", pretty: false, declaration: true },
    )
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>')
  })

  test("pretty indentation", () => {
    const out = stringifyXml(
      { a: { b: "hi", c: "yo" } },
      { attributePrefix: "@", textKey: "#text", pretty: true, declaration: false },
    )
    expect(out).toBe("<a>\n  <b>hi</b>\n  <c>yo</c>\n</a>")
  })

  test("rejects multi-key root", () => {
    expect(() =>
      stringifyXml({ a: 1, b: 2 }, { attributePrefix: "@", textKey: "#text", pretty: false, declaration: false }),
    ).toThrow()
  })

  test("escapes special chars in text and attrs", () => {
    const out = stringifyXml(
      { a: { "@x": '"<&', "#text": "<&>" } },
      { attributePrefix: "@", textKey: "#text", pretty: false, declaration: false },
    )
    expect(out).toBe('<a x="&quot;&lt;&amp;">&lt;&amp;&gt;</a>')
  })

  test("round-trip simple feed", () => {
    const original = { rss: { "@version": "2.0", channel: { title: "X" } } }
    const xml = stringifyXml(original, {
      attributePrefix: "@",
      textKey: "#text",
      pretty: false,
      declaration: false,
    })
    expect(parseXml(xml)).toEqual(original)
  })
})

describe("xml entity helpers", () => {
  test("decodeEntities handles all named entities", () => {
    expect(decodeEntities("&amp;&lt;&gt;&quot;&apos;")).toBe(`&<>"'`)
  })
  test("encodeEntities escapes < & > by default", () => {
    expect(encodeEntities("<a&b>")).toBe("&lt;a&amp;b&gt;")
  })
  test("encodeEntities escapes \" when attr=true", () => {
    expect(encodeEntities('"hi"', true)).toBe("&quot;hi&quot;")
  })
})
