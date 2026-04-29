import { describe, expect, test } from "bun:test"

import { __testing } from "@/tool/markdown"

const SAMPLE = `# Top Level

Some intro text with [a link](https://example.com "title") and an ![image](images/cat.png).

## Sub One

Body of sub one.

\`\`\`ts
const x = 1
console.log(x)
\`\`\`

### Deeper

Deeper body.

## Sub Two

Final paragraph.

Setext Heading
==============

Setext body.

`

describe("markdown helpers", () => {
  test("slugify handles diacritics and punctuation", () => {
    expect(__testing.slugify("Café Résumé")).toBe("cafe-resume")
    expect(__testing.slugify("Hello, World!")).toBe("hello-world")
    expect(__testing.slugify("  many   spaces  ")).toBe("many-spaces")
  })

  test("extractHeadings finds ATX + Setext", () => {
    const hs = __testing.extractHeadings(SAMPLE)
    expect(hs.map((h) => `${h.level}:${h.text}`)).toEqual([
      "1:Top Level",
      "2:Sub One",
      "3:Deeper",
      "2:Sub Two",
      "1:Setext Heading",
    ])
    expect(hs[0]!.slug).toBe("top-level")
  })

  test("extractHeadings dedupes slugs", () => {
    const md = `# Same\n## Same\n## Same`
    const slugs = __testing.extractHeadings(md).map((h) => h.slug)
    expect(slugs).toEqual(["same", "same-1", "same-2"])
  })

  test("extractLinks ignores links inside code fences", () => {
    const md = "Real [outside](https://o.test)\n\n```\n[inside](https://i.test)\n```\n"
    const { links } = __testing.extractLinks(md)
    expect(links).toHaveLength(1)
    expect(links[0]!.href).toBe("https://o.test")
  })

  test("extractLinks recovers title and image alt", () => {
    const out = __testing.extractLinks(SAMPLE)
    expect(out.links).toHaveLength(1)
    expect(out.links[0]!.text).toBe("a link")
    expect(out.links[0]!.title).toBe("title")
    expect(out.images).toHaveLength(1)
    expect(out.images[0]!.alt).toBe("image")
    expect(out.images[0]!.src).toBe("images/cat.png")
  })

  test("extractCodeBlocks captures language and content", () => {
    const blocks = __testing.extractCodeBlocks(SAMPLE)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.language).toBe("ts")
    expect(blocks[0]!.content).toContain("console.log(x)")
  })

  test("toPlain strips formatting but keeps code", () => {
    const md = "Hello **bold** _italic_ `code` text.\n\n```\nliteral\n```\n"
    const out = __testing.toPlain(md)
    expect(out).toContain("Hello bold italic code text.")
    expect(out).toContain("literal")
    expect(out).not.toContain("**")
  })

  test("tableOfContents emits indented links", () => {
    const toc = __testing.tableOfContents(SAMPLE)
    expect(toc).toContain("- [Top Level](#top-level)")
    expect(toc).toContain("  - [Sub One](#sub-one)")
    expect(toc).toContain("    - [Deeper](#deeper)")
  })

  test("extractSection returns body until next same-level heading", () => {
    const r = __testing.extractSection(SAMPLE, { slug: "sub-one" })
    expect(r).toBeDefined()
    expect(r!.body).toContain("Body of sub one")
    expect(r!.body).toContain("Deeper body")
    expect(r!.body).not.toContain("Sub Two")
  })

  test("extractSection works with heading_text (case-insensitive)", () => {
    const r = __testing.extractSection(SAMPLE, { heading_text: "sub two" })
    expect(r).toBeDefined()
    expect(r!.body).toContain("Final paragraph")
  })

  test("stats counts headings, links, images, code blocks", () => {
    const s = __testing.stats(SAMPLE)
    expect(s.headings).toBe(5)
    expect(s.links).toBeGreaterThanOrEqual(1)
    expect(s.images).toBe(1)
    expect(s.code_blocks).toBe(1)
    expect(s.lines).toBeGreaterThan(10)
  })
})
