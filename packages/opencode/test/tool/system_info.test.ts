import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/system_info"

const {
  decodeChassis,
  parseVramString,
  parseLspciVgaLine,
  parseLspciCells,
  CHASSIS_LABELS,
  gatherOs,
  gatherCpu,
  gatherMemory,
  gatherNetwork,
  formatOutput,
  summariseTitle,
} = __testing

describe("system_info.decodeChassis", () => {
  test("maps numeric chassis types to labels", () => {
    expect(decodeChassis("3")).toBe("Desktop")
    expect(decodeChassis("9")).toBe("Laptop")
    expect(decodeChassis("10")).toBe("Notebook")
    expect(decodeChassis("31")).toBe("Convertible")
    expect(decodeChassis("23")).toBe("Rack Mount Chassis")
  })

  test("returns null for null/undefined/empty", () => {
    expect(decodeChassis(undefined)).toBeNull()
    expect(decodeChassis("")).toBeNull()
    expect(decodeChassis("   ")).toBeNull()
  })

  test("falls back to a `Type N` placeholder for unknown numeric codes", () => {
    expect(decodeChassis("999")).toBe("Type 999")
  })

  test("trims whitespace before lookup", () => {
    expect(decodeChassis(" 9 ")).toBe("Laptop")
  })

  test("accepts numeric values directly", () => {
    expect(decodeChassis(9 as any)).toBe("Laptop")
  })

  test("CHASSIS_LABELS table covers desktop, notebook, server, and convertible classes", () => {
    expect(CHASSIS_LABELS["3"]).toBe("Desktop")
    expect(CHASSIS_LABELS["10"]).toBe("Notebook")
    expect(CHASSIS_LABELS["23"]).toBe("Rack Mount Chassis")
    expect(CHASSIS_LABELS["31"]).toBe("Convertible")
  })
})

describe("system_info.parseVramString", () => {
  test("parses GB", () => {
    expect(parseVramString("8 GB")).toBe(8 * 1024)
    expect(parseVramString("4.0 GB")).toBe(4096)
    expect(parseVramString("16gb")).toBe(16 * 1024)
  })

  test("parses MB", () => {
    expect(parseVramString("4096 MB")).toBe(4096)
    expect(parseVramString("512MB")).toBe(512)
  })

  test("parses bare number as MB", () => {
    expect(parseVramString("2048")).toBe(2048)
  })

  test("parses KB and rounds to MB", () => {
    expect(parseVramString("4194304 KB")).toBe(4096)
  })

  test("returns null for nonsense", () => {
    expect(parseVramString("")).toBeNull()
    expect(parseVramString(undefined)).toBeNull()
    expect(parseVramString(null)).toBeNull()
    expect(parseVramString("?")).toBeNull()
    expect(parseVramString("4 TB")).toBeNull()
  })
})

describe("system_info.parseLspciCells", () => {
  test("splits unquoted cells by whitespace", () => {
    expect(parseLspciCells("00:02.0 a b c")).toEqual(["00:02.0", "a", "b", "c"])
  })

  test("preserves spaces inside quoted cells", () => {
    expect(parseLspciCells('00:02.0 "VGA compatible controller" "Intel Corporation" "HD Graphics 630"')).toEqual([
      "00:02.0",
      "VGA compatible controller",
      "Intel Corporation",
      "HD Graphics 630",
    ])
  })

  test("collapses runs of internal whitespace", () => {
    expect(parseLspciCells("a    b    c")).toEqual(["a", "b", "c"])
  })

  test("returns single cell for no separators", () => {
    expect(parseLspciCells("alone")).toEqual(["alone"])
  })
})

describe("system_info.parseLspciVgaLine", () => {
  test("parses an Intel iGPU VGA row", () => {
    const row = parseLspciVgaLine(
      '00:02.0 "VGA compatible controller" "Intel Corporation" "HD Graphics 630" -r05 "Dell" "1234"',
    )
    expect(row).toBeDefined()
    expect(row!.name).toBe("Intel Corporation HD Graphics 630")
    expect(row!.pnp_device_id).toBe("00:02.0")
  })

  test("parses an NVIDIA discrete GPU 3D controller row", () => {
    const row = parseLspciVgaLine(
      '01:00.0 "3D controller" "NVIDIA Corporation" "GP107M [GeForce GTX 1050 Ti Mobile]"',
    )
    expect(row).toBeDefined()
    expect(row!.name).toContain("NVIDIA Corporation")
    expect(row!.name).toContain("1050 Ti Mobile")
  })

  test("parses a Display controller row", () => {
    const row = parseLspciVgaLine('02:00.0 "Display controller" "Some Vendor" "Some Card"')
    expect(row).toBeDefined()
    expect(row!.name).toBe("Some Vendor Some Card")
  })

  test("ignores non-graphics rows", () => {
    expect(parseLspciVgaLine('00:1f.0 "ISA bridge" "Intel" "Some Bridge"')).toBeUndefined()
    expect(parseLspciVgaLine('00:1c.0 "PCI bridge" "Intel" "Root Port"')).toBeUndefined()
  })

  test("ignores blank lines", () => {
    expect(parseLspciVgaLine("")).toBeUndefined()
    expect(parseLspciVgaLine("   ")).toBeUndefined()
  })
})

describe("system_info.gatherOs/gatherCpu/gatherMemory", () => {
  test("gatherOs returns a populated record", () => {
    const info = gatherOs()
    expect(info.platform).toBe(process.platform)
    expect(info.arch).toBeTruthy()
    expect(typeof info.uptime_seconds).toBe("number")
    expect(info.uptime_seconds).toBeGreaterThanOrEqual(0)
    expect(info.hostname).toBeTruthy()
  })

  test("gatherCpu reports cores >= 1 and a model string", () => {
    const info = gatherCpu()
    expect(info.cores).toBeGreaterThanOrEqual(1)
    expect(typeof info.model).toBe("string")
    expect(info.model.length).toBeGreaterThan(0)
    expect(info.arch).toBeTruthy()
  })

  test("gatherMemory totals add up", () => {
    const info = gatherMemory()
    expect(info.total_mb).toBeGreaterThan(0)
    expect(info.free_mb).toBeGreaterThanOrEqual(0)
    expect(info.used_mb).toBeGreaterThanOrEqual(0)
    expect(info.percent_used).toBeGreaterThanOrEqual(0)
    expect(info.percent_used).toBeLessThanOrEqual(100)
    // total ≈ used + free, allowing 1 MB rounding slack each direction
    const sum = info.used_mb + info.free_mb
    expect(Math.abs(sum - info.total_mb)).toBeLessThanOrEqual(2)
  })

  test("gatherNetwork returns at least the loopback interface", () => {
    const ifaces = gatherNetwork()
    expect(ifaces.length).toBeGreaterThanOrEqual(1)
    expect(ifaces.some((i) => i.internal)).toBe(true)
  })
})

describe("system_info.formatOutput / summariseTitle", () => {
  test("formatOutput renders all sections that are present", () => {
    const text = formatOutput({
      action: "summary",
      platform: "win32",
      os: {
        platform: "win32",
        type: "Windows_NT",
        release: "10.0.22631",
        version: "Windows 11 Pro",
        arch: "x64",
        hostname: "DESKTOP-XYZ",
        uptime_seconds: 3600,
        user: "User",
      },
      cpu: { model: "Intel(R) Core(TM) i7-7700HQ", cores: 8, arch: "x64", speed_ghz: 2.8 },
      memory: { total_mb: 16384, free_mb: 4096, used_mb: 12288, percent_used: 75 },
      system: {
        manufacturer: "Dell Inc.",
        model: "Inspiron 15 7000 Gaming",
        chassis_type: "Notebook",
        serial: "ABC123",
      },
      gpu: [
        { name: "NVIDIA GeForce GTX 1050 Ti", driver_version: "32.0.15.8228", vram_mb: 4096 },
        { name: "Intel HD Graphics 630", driver_version: "27.20.100.9466", vram_mb: 1024 },
      ],
      elapsed_ms: 42,
    })
    expect(text).toContain("OS: win32 10.0.22631")
    expect(text).toContain("Dell Inc. Inspiron 15 7000 Gaming")
    expect(text).toContain("chassis=Notebook")
    expect(text).toContain("Intel(R) Core(TM) i7-7700HQ")
    expect(text).toContain("NVIDIA GeForce GTX 1050 Ti")
    expect(text).toContain("16.0 GB total")
  })

  test("formatOutput is silent for sections that are absent", () => {
    const text = formatOutput({ action: "memory", platform: "linux", elapsed_ms: 5 })
    expect(text).toBe("")
  })

  test("summariseTitle includes a chunk per populated section", () => {
    const title = summariseTitle({
      action: "summary",
      platform: "linux",
      os: {
        platform: "linux",
        type: "Linux",
        release: "6.5.0",
        version: "Ubuntu",
        arch: "x64",
        hostname: "h",
        uptime_seconds: 1,
        user: "u",
      },
      cpu: { model: "AMD", cores: 16, arch: "x64", speed_ghz: 3.6 },
      memory: { total_mb: 32768, free_mb: 16384, used_mb: 16384, percent_used: 50 },
      gpu: [{ name: "NVIDIA RTX A4000", driver_version: "535.x", vram_mb: 16384 }],
      elapsed_ms: 1,
    })
    expect(title).toContain("linux 6.5.0")
    expect(title).toContain("16c CPU")
    expect(title).toContain("32.0 GB RAM")
    expect(title).toContain("RTX A4000")
  })

  test("summariseTitle falls back to action label when nothing was gathered", () => {
    expect(summariseTitle({ action: "memory", platform: "linux", elapsed_ms: 0 })).toBe("system_info memory")
  })
})
