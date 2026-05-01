import { EOL } from "os"
import { ToolRegistry } from "../../../tool"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"
import { AppRuntime } from "@/effect/app-runtime"

export const SG_NATIVE_TOOL_IDS = [
  "archive",
  "audio",
  "automation",
  "bench",
  "bignum",
  "chunk",
  "cidr",
  "clipboard",
  "color",
  "compress",
  "country",
  "cron",
  "crypto",
  "csv",
  "datetime",
  "diff",
  "disk",
  "dns",
  "dotenv",
  "download",
  "encode",
  "env",
  "feed",
  "fuzzy",
  "graphql",
  "hash",
  "html",
  "http",
  "humanize",
  "ical",
  "image",
  "ini",
  "json",
  "jsonpath",
  "jwt",
  "kdf",
  "kv",
  "latlon",
  "lockfile",
  "lorem",
  "luhn",
  "markdown",
  "mask",
  "math",
  "mime",
  "net_check",
  "notify",
  "open",
  "otp",
  "path",
  "pkce",
  "port_scan",
  "powershell",
  "primes",
  "process",
  "random",
  "regex",
  "screenshot",
  "semver",
  "sg_doctor",
  "slug",
  "sqlite",
  "stats",
  "system_info",
  "tabulate",
  "template",
  "text",
  "tls",
  "toml",
  "tree",
  "ulid",
  "unicode",
  "unit",
  "url",
  "uuid",
  "wait",
  "which",
  "whois",
  "xml",
  "xpath",
  "yaml",
] as const

export function smokeToolIDs(ids: string[], sgOnly: boolean) {
  const available = new Set(ids)
  const expected = sgOnly ? SG_NATIVE_TOOL_IDS : ids.toSorted()
  return {
    ids: expected.filter((id) => available.has(id)),
    missing: sgOnly ? SG_NATIVE_TOOL_IDS.filter((id) => !available.has(id)) : [],
  }
}

export function formatToolSmoke(result: ReturnType<typeof smokeToolIDs>, json: boolean) {
  if (json) return JSON.stringify(result, null, 2) + EOL
  return result.ids.join(EOL) + (result.ids.length ? EOL : "")
}

export const ToolsCommand = cmd({
  command: "tools",
  describe: "list registered tool ids",
  builder: (yargs) =>
    yargs
      .option("sg", {
        type: "boolean",
        describe: "only list SG native tool ids",
      })
      .option("check-sg", {
        type: "boolean",
        describe: "exit non-zero if any expected SG native tool id is missing",
      })
      .option("json", {
        type: "boolean",
        describe: "print JSON output",
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const result = smokeToolIDs(
        await AppRuntime.runPromise(ToolRegistry.Service.use((service) => service.ids())),
        Boolean(args.sg || args.checkSg),
      )

      process.stdout.write(formatToolSmoke(result, Boolean(args.json)))
      if (result.missing.length) {
        process.stderr.write(`Missing SG native tools: ${result.missing.join(", ")}` + EOL)
        if (args.checkSg) process.exit(1)
      }
    })
  },
})
