import { describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { FeedTool, __testing } from "../../src/tool/feed"
import { Truncate } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer),
)

const baseCtx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const recordAsk = (calls: Array<Parameters<Tool.Context["ask"]>[0]>, fail = false): Tool.Context["ask"] => (input) =>
  Effect.sync(() => {
    calls.push(input)
    if (fail) throw new Error("permission probe")
  })

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Blog</title>
    <link>https://example.com/</link>
    <description>An example feed</description>
    <language>en-us</language>
    <item>
      <title>Hello World</title>
      <link>https://example.com/p/1</link>
      <pubDate>Wed, 01 Apr 2026 12:00:00 GMT</pubDate>
      <description>First post</description>
      <guid>https://example.com/p/1</guid>
      <category>news</category>
      <category>release</category>
      <enclosure url="https://example.com/p/1.mp3" length="123" type="audio/mpeg" />
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/p/2</link>
      <pubDate>Tue, 02 Apr 2026 09:00:00 GMT</pubDate>
      <description>Another <b>post</b></description>
    </item>
  </channel>
</rss>`

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title>
  <subtitle>Subtitle</subtitle>
  <link href="https://example.com/" rel="alternate" />
  <link href="https://example.com/feed.xml" rel="self" />
  <updated>2026-04-30T00:00:00Z</updated>
  <author><name>Alice</name></author>
  <entry>
    <id>tag:example.com,2026:1</id>
    <title>Atom Post</title>
    <link href="https://example.com/atom/1" />
    <updated>2026-04-30T00:00:00Z</updated>
    <published>2026-04-29T00:00:00Z</published>
    <summary>Hello atom</summary>
    <content type="html">&lt;p&gt;Body&lt;/p&gt;</content>
    <category term="general" />
  </entry>
</feed>`

const JSONFEED = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "JSON Feed Test",
  home_page_url: "https://example.com/",
  feed_url: "https://example.com/feed.json",
  items: [
    {
      id: "1",
      url: "https://example.com/j/1",
      title: "JSON 1",
      content_text: "Body 1",
      date_published: "2026-04-30T00:00:00Z",
      tags: ["a", "b"],
      attachments: [{ url: "https://example.com/a.mp3", mime_type: "audio/mpeg", size_in_bytes: 1024 }],
    },
  ],
})

describe("tool.feed helpers", () => {
  test("detectFormat", () => {
    expect(__testing.detectFormat(RSS)).toBe("rss")
    expect(__testing.detectFormat(ATOM)).toBe("atom")
    expect(__testing.detectFormat(JSONFEED)).toBe("json")
    expect(__testing.detectFormat("not a feed")).toBe("unknown")
  })
  test("isHttpUrl", () => {
    expect(__testing.isHttpUrl("https://example.com/feed.xml")).toBe(true)
    expect(__testing.isHttpUrl("http://example.com/feed.xml")).toBe(true)
    expect(__testing.isHttpUrl("ftp://example.com/feed.xml")).toBe(false)
  })
  test("parseRss extracts items + enclosures", () => {
    const root = __testing.parseXml(RSS)!
    const { head, items } = __testing.parseRss(root)
    expect(head.title).toBe("Example Blog")
    expect(items).toHaveLength(2)
    expect(items[0]!.title).toBe("Hello World")
    expect(items[0]!.categories).toEqual(["news", "release"])
    expect(items[0]!.enclosures?.[0]?.url).toBe("https://example.com/p/1.mp3")
    expect(items[0]!.enclosures?.[0]?.length).toBe(123)
  })
  test("parseAtom extracts items + alternate link", () => {
    const root = __testing.parseXml(ATOM)!
    const { head, items } = __testing.parseAtom(root)
    expect(head.title).toBe("Example Atom")
    expect(head.link).toBe("https://example.com/")
    expect(head.self_link).toBe("https://example.com/feed.xml")
    expect(head.author).toBe("Alice")
    expect(items[0]!.link).toBe("https://example.com/atom/1")
    expect(items[0]!.title).toBe("Atom Post")
  })
  test("parseJsonFeed", () => {
    const { head, items } = __testing.parseJsonFeed(JSON.parse(JSONFEED))
    expect(head.title).toBe("JSON Feed Test")
    expect(head.self_link).toBe("https://example.com/feed.json")
    expect(items[0]!.title).toBe("JSON 1")
    expect(items[0]!.enclosures?.[0]?.length).toBe(1024)
  })
})

describe("tool.feed tool", () => {
  it.live("parse RSS via inline value", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* FeedTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "parse", value: RSS }, baseCtx)
        expect(r.metadata.format).toBe("rss")
        expect(r.metadata.item_count).toBe(2)
      }),
    ),
  )
  it.live("latest limits item count", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* FeedTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "latest", value: RSS, limit: 1 }, baseCtx)
        const items = JSON.parse(r.output as string)
        expect(items).toHaveLength(1)
        expect(items[0].title).toBe("Hello World")
      }),
    ),
  )
  it.live("head for atom", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* FeedTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "head", value: ATOM }, baseCtx)
        const head = JSON.parse(r.output as string)
        expect(head.title).toBe("Example Atom")
        expect(head.self_link).toBe("https://example.com/feed.xml")
      }),
    ),
  )
  it.live("format detection only", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* FeedTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "format", value: JSONFEED }, baseCtx)
        expect(r.metadata.format).toBe("json")
      }),
    ),
  )
  it.live("asks read permission before loading feed files", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const filePath = path.join(dir, "feed.xml")
        yield* Effect.promise(() => fs.writeFile(filePath, RSS))
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const toolInfo = yield* FeedTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "format", filePath }, { ...baseCtx, ask: recordAsk(calls) })

        expect(r.metadata.source).toBe("file")
        expect(calls).toHaveLength(1)
        expect(calls[0]!.permission).toBe("read")
        expect(calls[0]!.patterns).toEqual([filePath])
      }),
    ),
  )
  it.live("asks webfetch permission before fetching feed URLs", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const toolInfo = yield* FeedTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            { action: "format", url: "https://example.com/feed.xml" },
            { ...baseCtx, ask: recordAsk(calls, true) },
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.permission).toBe("webfetch")
        expect(calls[0]!.patterns).toEqual(["https://example.com/feed.xml"])
      }),
    ),
  )
})
