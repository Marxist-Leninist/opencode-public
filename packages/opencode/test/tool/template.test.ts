import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/template"

const { parseTemplate, renderNodes, extractVariables, htmlEscape } = __testing

function render(template: string, data: unknown, opts?: { strict?: boolean; escape?: "none" | "html" }): string {
  const nodes = parseTemplate(template)
  return renderNodes(nodes, data, { strict: opts?.strict ?? false, escape: opts?.escape ?? "none" })
}

describe("template.render", () => {
  test("simple substitution", () => {
    expect(render("Hello, {{name}}!", { name: "world" })).toBe("Hello, world!")
  })

  test("dot path", () => {
    expect(render("{{user.profile.email}}", { user: { profile: { email: "x@y" } } })).toBe("x@y")
  })

  test("missing var: empty in non-strict", () => {
    expect(render("Hi {{name}}!", {})).toBe("Hi !")
  })

  test("missing var: throws in strict", () => {
    expect(() => render("Hi {{name}}!", {}, { strict: true })).toThrow(/missing variable/)
  })

  test("comments removed", () => {
    expect(render("a{{!hidden}}b", {})).toBe("ab")
  })

  test("each over array of strings", () => {
    expect(render("{{#each items}}- {{this}}\n{{/each}}", { items: ["a", "b", "c"] })).toBe("- a\n- b\n- c\n")
  })

  test("each exposes object keys directly", () => {
    expect(
      render("{{#each users}}{{name}}={{age}};{{/each}}", {
        users: [
          { name: "alice", age: 30 },
          { name: "bob", age: 25 },
        ],
      }),
    ).toBe("alice=30;bob=25;")
  })

  test("each with @index", () => {
    expect(render("{{#each items}}{{@index}}:{{this}};{{/each}}", { items: ["a", "b"] })).toBe("0:a;1:b;")
  })

  test("each with @first/@last via #if", () => {
    expect(
      render("{{#each items}}{{#if @first}}<{{/if}}{{this}}{{#if @last}}>{{/if}}|{{/each}}", { items: ["a", "b", "c"] }),
    ).toBe("<a|b|c>|")
  })

  test("each over empty array yields nothing", () => {
    expect(render("[{{#each items}}x{{/each}}]", { items: [] })).toBe("[]")
  })

  test("if truthy", () => {
    expect(render("{{#if x}}yes{{/if}}", { x: 1 })).toBe("yes")
    expect(render("{{#if x}}yes{{/if}}", { x: 0 })).toBe("")
    expect(render("{{#if x}}yes{{/if}}", { x: [] })).toBe("")
    expect(render("{{#if x}}yes{{/if}}", { x: ["a"] })).toBe("yes")
    expect(render("{{#if x}}yes{{/if}}", { x: "" })).toBe("")
    expect(render("{{#if x}}yes{{/if}}", { x: "no" })).toBe("yes")
  })

  test("if/else", () => {
    expect(render("{{#if x}}A{{else}}B{{/if}}", { x: true })).toBe("A")
    expect(render("{{#if x}}A{{else}}B{{/if}}", { x: false })).toBe("B")
  })

  test("unless", () => {
    expect(render("{{#unless x}}none{{/unless}}", { x: false })).toBe("none")
    expect(render("{{#unless x}}none{{/unless}}", { x: true })).toBe("")
  })

  test("nested sections", () => {
    expect(
      render("{{#each rows}}{{#each .}}({{this}}){{/each}}|{{/each}}", { rows: [["a", "b"], ["c"]] }),
    ).toBe("(a)(b)|(c)|")
  })

  test("triple-stash bypasses html escape", () => {
    expect(render("{{x}} vs {{{x}}}", { x: "<b>hi</b>" }, { escape: "html" })).toBe(
      "&lt;b&gt;hi&lt;/b&gt; vs <b>hi</b>",
    )
  })

  test("non-string values stringified", () => {
    expect(render("{{n}} {{b}} {{a}}", { n: 42, b: true, a: { x: 1 } })).toBe('42 true {"x":1}')
  })

  test("whitespace around var name tolerated", () => {
    expect(render("{{ name }}", { name: "ok" })).toBe("ok")
  })

  test("ancestor frame lookup inside each", () => {
    expect(
      render("{{#each items}}{{prefix}}{{this}};{{/each}}", { prefix: "*", items: ["a", "b"] }),
    ).toBe("*a;*b;")
  })

  test("malformed: unclosed section throws", () => {
    expect(() => render("{{#if x}}stuff", { x: 1 })).toThrow()
  })

  test("malformed: mismatched close throws", () => {
    expect(() => render("{{#if x}}stuff{{/each}}", { x: 1 })).toThrow()
  })

  test("else outside if is rejected", () => {
    expect(() => render("foo{{else}}bar", {})).toThrow()
  })

  test("each does not allow else", () => {
    expect(() => render("{{#each items}}x{{else}}y{{/each}}", { items: [] })).toThrow()
  })
})

describe("template.extract", () => {
  test("returns sorted unique variables", () => {
    expect(extractVariables(parseTemplate("Hi {{user.name}} you have {{count}} {{count}}"))).toEqual([
      "count",
      "user.name",
    ])
  })

  test("includes section paths but not @-vars or this", () => {
    expect(
      extractVariables(parseTemplate("{{#each items}}{{this}}{{@index}}{{/each}}{{#if cond}}x{{/if}}")),
    ).toEqual(["cond", "items"])
  })
})

describe("template helpers", () => {
  test("htmlEscape", () => {
    expect(htmlEscape(`<a href="x">&y'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;y&#39;&lt;/a&gt;")
  })
})
