import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/process"

const {
  parseCsvLine,
  parseTasklistCsvLine,
  parsePsLine,
  parseNetstatTcpLine,
  parseLsofLine,
  parseSsLine,
  runProcess,
} = __testing

describe("process.parseCsvLine", () => {
  test("splits a plain comma-separated line", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"])
  })
  test("preserves commas inside quoted cells", () => {
    expect(parseCsvLine('"a,b","c","d,e,f"')).toEqual(["a,b", "c", "d,e,f"])
  })
  test("handles escaped double-quotes inside quoted cells", () => {
    expect(parseCsvLine('"he said ""hi""","ok"')).toEqual(['he said "hi"', "ok"])
  })
  test("handles empty trailing cell", () => {
    expect(parseCsvLine("a,b,")).toEqual(["a", "b", ""])
  })
})

describe("process.parseTasklistCsvLine", () => {
  test("parses a Windows tasklist row", () => {
    const row = parseTasklistCsvLine('"OpenCode Dev.exe","20976","Console","1","224,092 K"')
    expect(row).toBeDefined()
    expect(row!.pid).toBe(20976)
    expect(row!.name).toBe("OpenCode Dev.exe")
    expect(row!.rss_kb).toBe(224092)
  })
  test("returns undefined for malformed lines", () => {
    expect(parseTasklistCsvLine("not,enough,cells")).toBeUndefined()
    expect(parseTasklistCsvLine("")).toBeUndefined()
    expect(parseTasklistCsvLine('"name","not-a-pid","s","1","12 K"')).toBeUndefined()
  })
})

describe("process.parsePsLine", () => {
  test("parses a normal ps -eo pid,comm,pcpu,rss line", () => {
    const row = parsePsLine("12345 bun 1.5 4096")
    expect(row).toBeDefined()
    expect(row!.pid).toBe(12345)
    expect(row!.name).toBe("bun")
    expect(row!.cpu_percent).toBe(1.5)
    expect(row!.rss_kb).toBe(4096)
  })
  test("handles command names with spaces in the comm column", () => {
    // ps `comm` shouldn't have spaces typically, but if you ever swap it for `args` you get them.
    // The parser collapses everything between the pid and the last two numerical columns.
    const row = parsePsLine("9999 my fancy app 0.0 1024")
    expect(row).toBeDefined()
    expect(row!.pid).toBe(9999)
    expect(row!.name).toBe("my fancy app")
    expect(row!.cpu_percent).toBe(0.0)
    expect(row!.rss_kb).toBe(1024)
  })
  test("returns undefined for blank or malformed input", () => {
    expect(parsePsLine("")).toBeUndefined()
    expect(parsePsLine("   ")).toBeUndefined()
    expect(parsePsLine("not a pid bun 0.0 1024")).toBeUndefined()
    expect(parsePsLine("just three tokens here")).toBeUndefined()
  })
})

describe("process.parseNetstatTcpLine", () => {
  test("parses a Windows TCP LISTENING row", () => {
    const row = parseNetstatTcpLine("  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1344")
    expect(row).toBeDefined()
    expect(row!.proto).toBe("TCP")
    expect(row!.pid).toBe(1344)
    expect(row!.port).toBe(135)
    expect(row!.local_address).toBe("0.0.0.0")
  })
  test("parses an IPv6 listening row", () => {
    const row = parseNetstatTcpLine("  TCP    [::]:445               [::]:0                 LISTENING       4")
    expect(row).toBeDefined()
    expect(row!.pid).toBe(4)
    expect(row!.port).toBe(445)
    expect(row!.local_address).toBe("[::]")
  })
  test("ignores ESTABLISHED and other non-LISTENING TCP rows", () => {
    expect(
      parseNetstatTcpLine("  TCP    10.0.0.1:49339         104.16.8.34:443        ESTABLISHED     17148"),
    ).toBeUndefined()
    expect(
      parseNetstatTcpLine("  TCP    10.0.0.1:49347         52.123.129.14:443      CLOSE_WAIT      4052"),
    ).toBeUndefined()
  })
  test("ignores headers and blank lines", () => {
    expect(parseNetstatTcpLine("Active Connections")).toBeUndefined()
    expect(parseNetstatTcpLine("  Proto  Local Address          Foreign Address        State           PID")).toBeUndefined()
    expect(parseNetstatTcpLine("")).toBeUndefined()
  })
})

describe("process.parseLsofLine", () => {
  test("parses a typical lsof TCP LISTEN line", () => {
    const row = parseLsofLine("node     12345 user   23u  IPv4 0xabcdef      0t0  TCP *:3000 (LISTEN)")
    expect(row).toBeDefined()
    expect(row!.pid).toBe(12345)
    expect(row!.name).toBe("node")
    expect(row!.proto).toBe("TCP")
    expect(row!.port).toBe(3000)
    expect(row!.local_address).toBe("*")
  })
  test("ignores the header line", () => {
    expect(parseLsofLine("COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME")).toBeUndefined()
  })
})

describe("process.parseSsLine", () => {
  test("parses a typical ss -ltnpH line with users column", () => {
    const row = parseSsLine(
      'LISTEN 0      4096      0.0.0.0:3000        0.0.0.0:*    users:(("node",pid=12345,fd=23))',
    )
    expect(row).toBeDefined()
    expect(row!.pid).toBe(12345)
    expect(row!.name).toBe("node")
    expect(row!.proto).toBe("TCP")
    expect(row!.port).toBe(3000)
  })
  test("ignores rows that are not LISTEN", () => {
    expect(
      parseSsLine('ESTAB 0      0         10.0.0.1:443       1.2.3.4:50000  users:(("nginx",pid=1,fd=10))'),
    ).toBeUndefined()
  })
})

describe("process.runProcess", () => {
  test("captures exit code 0 from a trivial command", async () => {
    const cmd = process.platform === "win32" ? "cmd.exe" : "true"
    const args = process.platform === "win32" ? ["/c", "exit 0"] : []
    const r = await runProcess(cmd, args, new AbortController().signal, 5000)
    expect(r.code).toBe(0)
  })
  test("reports stderr for a missing executable without throwing", async () => {
    const r = await runProcess("definitely-not-a-real-binary-xyz", [], new AbortController().signal, 2000)
    expect(r.code).toBeNull()
    expect(r.stderr.length).toBeGreaterThan(0)
  })
})
