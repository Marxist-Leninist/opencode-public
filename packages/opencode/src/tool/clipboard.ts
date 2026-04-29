import { Effect, Schema } from "effect"
import clipboardy from "clipboardy"
import DESCRIPTION from "./clipboard.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["read", "write"]).annotate({
    description: "Action to perform on the clipboard: 'read' to fetch the current contents, 'write' to overwrite them.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "The text to copy to the clipboard. Required when action is 'write'.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  action: "read" | "write"
  text_length?: number
  error?: string
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const ClipboardTool = Tool.define(
  "clipboard",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Params, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        if (params.action === "write") {
          if (params.text === undefined) {
            yield* ctx.metadata({ metadata: { action: "write", error: "Missing text parameter" } })
            return done({
              title: "Clipboard write failed",
              output: "Error: the 'text' parameter is required when action is 'write'.",
              metadata: { action: "write", error: "Missing text parameter" },
            })
          }

          yield* ctx.metadata({
            title: `Clipboard write (${params.text.length} chars)`,
            metadata: { action: "write", text_length: params.text.length },
          })

          try {
            clipboardy.writeSync(params.text)
            return done({
              title: `Clipboard updated (${params.text.length} chars)`,
              output: `Copied ${params.text.length} characters to the clipboard.`,
              metadata: { action: "write", text_length: params.text.length },
            })
          } catch (e: any) {
            const msg = e?.message ?? String(e)
            return done({
              title: "Clipboard write failed",
              output: `Error writing to clipboard: ${msg}. Continue without retrying.`,
              metadata: { action: "write", error: msg },
            })
          }
        }

        yield* ctx.metadata({ title: "Clipboard read", metadata: { action: "read" } })

        try {
          const content = clipboardy.readSync()
          return done({
            title: `Clipboard read (${content.length} chars)`,
            output: `Clipboard content (${content.length} chars):\n\n${content}`,
            metadata: { action: "read", text_length: content.length },
          })
        } catch (e: any) {
          const msg = e?.message ?? String(e)
          return done({
            title: "Clipboard read failed",
            output: `Error reading from clipboard: ${msg}. Continue without retrying.`,
            metadata: { action: "read", error: msg },
          })
        }
      }),
  }),
)
