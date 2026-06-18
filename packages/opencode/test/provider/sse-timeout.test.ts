import { expect, test } from "bun:test"

import { wrapSSE } from "../../src/provider/provider"

test("SSE chunk timeout emits keepalive and continues reading", async () => {
  const encoder = new TextEncoder()
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => controller.enqueue(encoder.encode("data: late\n\n")), 30)
      setTimeout(() => controller.close(), 40)
    },
  })
  const abort = new AbortController()
  const response = wrapSSE(
    new Response(upstream, {
      headers: {
        "content-type": "text/event-stream",
      },
    }),
    5,
    abort,
  )

  const body = await response.text()

  expect(body).toContain(": opencode keepalive\n\n")
  expect(body).toContain("data: late\n\n")
  expect(abort.signal.aborted).toBe(false)
})
