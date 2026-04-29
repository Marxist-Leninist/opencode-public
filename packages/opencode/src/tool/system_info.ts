import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import * as os from "node:os"
import * as fs from "node:fs/promises"
import DESCRIPTION from "./system_info.txt"
import * as Tool from "./tool"

const ACTIONS = ["summary", "os", "cpu", "memory", "system", "gpu", "network", "all"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS)
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("summary" as const)))
    .annotate({
      description:
        "Which facts to gather. 'summary' covers OS+system+CPU+memory+GPU. 'all' adds network. Or request a single section: os/cpu/memory/system/gpu/network.",
    }),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1000), Schema.isLessThanOrEqualTo(30_000)),
  ).annotate({
    description: "Per-probe timeout in ms (1000-30000). Default 8000. Caps individual platform probes so a hang cannot stall the chat.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type OsInfo = {
  platform: NodeJS.Platform
  type: string
  release: string
  version: string
  arch: string
  hostname: string
  uptime_seconds: number
  user: string
}

type CpuInfo = {
  model: string
  cores: number
  arch: string
  speed_ghz: number
  loadavg_1m?: number
  loadavg_5m?: number
  loadavg_15m?: number
}

type MemoryInfo = {
  total_mb: number
  free_mb: number
  used_mb: number
  percent_used: number
}

type SystemInfo = {
  manufacturer: string | null
  model: string | null
  chassis_type: string | null
  serial: string | null
  bios_vendor?: string | null
  bios_version?: string | null
}

type GpuInfo = {
  name: string
  driver_version?: string | null
  vram_mb?: number | null
  pnp_device_id?: string | null
}

type NetIfaceInfo = {
  name: string
  mac: string | null
  ipv4: string | null
  ipv6: string | null
  internal: boolean
}

type Metadata = {
  action: Action
  platform: NodeJS.Platform
  os?: OsInfo
  cpu?: CpuInfo
  memory?: MemoryInfo
  system?: SystemInfo
  gpu?: GpuInfo[]
  network?: NetIfaceInfo[]
  warnings?: string[]
  elapsed_ms: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function runProcess(
  cmd: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    } catch (err: any) {
      resolve({ code: null, stdout: "", stderr: err?.message ?? String(err) })
      return
    }
    const timer = setTimeout(() => {
      if (!settled) {
        try {
          child.kill("SIGKILL")
        } catch {
          /* noop */
        }
      }
    }, timeoutMs)
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8")
    })
    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8")
    })
    const onAbort = () => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* noop */
      }
    }
    signal.addEventListener("abort", onAbort, { once: true })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve({ code: null, stdout, stderr: stderr + (err?.message ?? "") })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve({ code, stdout, stderr })
    })
  })
}

function gatherOs(): OsInfo {
  const userInfo = (() => {
    try {
      return os.userInfo().username
    } catch {
      return "?"
    }
  })()
  return {
    platform: process.platform,
    type: os.type(),
    release: os.release(),
    version: os.version(),
    arch: os.arch(),
    hostname: os.hostname(),
    uptime_seconds: Math.round(os.uptime()),
    user: userInfo,
  }
}

function gatherCpu(): CpuInfo {
  const cpus = os.cpus()
  const first = cpus[0]
  let load: number[] | undefined
  try {
    load = os.loadavg()
  } catch {
    load = undefined
  }
  return {
    model: first?.model?.trim() ?? "unknown",
    cores: cpus.length,
    arch: os.arch(),
    speed_ghz: first ? Number((first.speed / 1000).toFixed(2)) : 0,
    loadavg_1m: load?.[0],
    loadavg_5m: load?.[1],
    loadavg_15m: load?.[2],
  }
}

function gatherMemory(): MemoryInfo {
  const total = os.totalmem()
  const free = os.freemem()
  const used = total - free
  const mb = (b: number) => Math.round(b / 1024 / 1024)
  return {
    total_mb: mb(total),
    free_mb: mb(free),
    used_mb: mb(used),
    percent_used: total > 0 ? Math.round((used / total) * 100) : 0,
  }
}

function gatherNetwork(): NetIfaceInfo[] {
  const ifaces = os.networkInterfaces()
  const rows: NetIfaceInfo[] = []
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue
    let mac: string | null = null
    let ipv4: string | null = null
    let ipv6: string | null = null
    let internal = true
    for (const entry of list) {
      if (entry.mac && entry.mac !== "00:00:00:00:00:00") mac = entry.mac
      if (entry.family === "IPv4" && !ipv4) ipv4 = entry.address
      if (entry.family === "IPv6" && !ipv6 && !entry.address.startsWith("fe80")) ipv6 = entry.address
      if (!entry.internal) internal = false
    }
    rows.push({ name, mac, ipv4, ipv6, internal })
  }
  return rows
}

const CHASSIS_LABELS: Record<string, string> = {
  // Win32_SystemEnclosure ChassisTypes
  "1": "Other",
  "2": "Unknown",
  "3": "Desktop",
  "4": "Low Profile Desktop",
  "5": "Pizza Box",
  "6": "Mini Tower",
  "7": "Tower",
  "8": "Portable",
  "9": "Laptop",
  "10": "Notebook",
  "11": "Hand Held",
  "12": "Docking Station",
  "13": "All in One",
  "14": "Sub Notebook",
  "15": "Space-saving",
  "16": "Lunch Box",
  "17": "Main System Chassis",
  "18": "Expansion Chassis",
  "19": "SubChassis",
  "20": "Bus Expansion Chassis",
  "21": "Peripheral Chassis",
  "22": "Storage Chassis",
  "23": "Rack Mount Chassis",
  "24": "Sealed-case PC",
  "30": "Tablet",
  "31": "Convertible",
  "32": "Detachable",
  "33": "IoT Gateway",
  "34": "Embedded PC",
  "35": "Mini PC",
  "36": "Stick PC",
}

function decodeChassis(raw: string | number | undefined): string | null {
  if (raw === undefined || raw === null) return null
  const key = String(raw).trim()
  if (!key) return null
  return CHASSIS_LABELS[key] ?? `Type ${key}`
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function gatherWindowsSystem(signal: AbortSignal, timeoutMs: number): Promise<{ system: SystemInfo; warnings: string[] }> {
  const warnings: string[] = []
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$cs = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$enc = Get-CimInstance Win32_SystemEnclosure
[pscustomobject]@{
  manufacturer = $cs.Manufacturer
  model = $cs.Model
  chassis_types = ($enc.ChassisTypes -join ',')
  serial = $bios.SerialNumber
  bios_vendor = $bios.Manufacturer
  bios_version = $bios.SMBIOSBIOSVersion
} | ConvertTo-Json -Compress
`.trim()
  const result = await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    signal,
    timeoutMs,
  )
  const data = safeJsonParse(result.stdout.trim())
  if (!data) {
    warnings.push(`system probe failed: code=${result.code} stderr=${(result.stderr || "").slice(0, 200)}`)
    return {
      system: { manufacturer: null, model: null, chassis_type: null, serial: null },
      warnings,
    }
  }
  const chassisRaw = typeof data.chassis_types === "string" ? data.chassis_types.split(",")[0] : data.chassis_types
  return {
    system: {
      manufacturer: data.manufacturer ?? null,
      model: data.model ?? null,
      chassis_type: decodeChassis(chassisRaw),
      serial: data.serial ?? null,
      bios_vendor: data.bios_vendor ?? null,
      bios_version: data.bios_version ?? null,
    },
    warnings,
  }
}

async function gatherWindowsGpu(signal: AbortSignal, timeoutMs: number): Promise<{ gpu: GpuInfo[]; warnings: string[] }> {
  const warnings: string[] = []
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_VideoController | ForEach-Object {
  [pscustomobject]@{
    name = $_.Name
    driver_version = $_.DriverVersion
    vram_bytes = [int64]$_.AdapterRAM
    pnp_device_id = $_.PNPDeviceID
  }
} | ConvertTo-Json -Compress
`.trim()
  const result = await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    signal,
    timeoutMs,
  )
  const data = safeJsonParse(result.stdout.trim())
  if (!data) {
    warnings.push(`gpu probe failed: code=${result.code} stderr=${(result.stderr || "").slice(0, 200)}`)
    return { gpu: [], warnings }
  }
  const arr = Array.isArray(data) ? data : [data]
  const gpu = arr
    .filter((g) => g && (g.name || g.driver_version))
    .map<GpuInfo>((g) => ({
      name: String(g.name ?? "unknown"),
      driver_version: g.driver_version ?? null,
      vram_mb:
        g.vram_bytes && Number(g.vram_bytes) > 0 ? Math.round(Number(g.vram_bytes) / 1024 / 1024) : null,
      pnp_device_id: g.pnp_device_id ?? null,
    }))
  return { gpu, warnings }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path, "utf8")
    return buf.trim()
  } catch {
    return null
  }
}

async function gatherLinuxSystem(): Promise<{ system: SystemInfo; warnings: string[] }> {
  const warnings: string[] = []
  const [manufacturer, model, chassisRaw, serial, biosVendor, biosVersion] = await Promise.all([
    readTextOrNull("/sys/class/dmi/id/sys_vendor"),
    readTextOrNull("/sys/class/dmi/id/product_name"),
    readTextOrNull("/sys/class/dmi/id/chassis_type"),
    readTextOrNull("/sys/class/dmi/id/product_serial"),
    readTextOrNull("/sys/class/dmi/id/bios_vendor"),
    readTextOrNull("/sys/class/dmi/id/bios_version"),
  ])
  if (!manufacturer && !model && !chassisRaw) {
    warnings.push("system probe: /sys/class/dmi/id is unreadable (need root for serial?)")
  }
  return {
    system: {
      manufacturer,
      model,
      chassis_type: decodeChassis(chassisRaw ?? undefined),
      serial,
      bios_vendor: biosVendor,
      bios_version: biosVersion,
    },
    warnings,
  }
}

function parseLspciVgaLine(line: string): GpuInfo | undefined {
  // -mm format: 00:02.0 "VGA compatible controller" "Intel Corporation" "HD Graphics 630" -r05 ...
  const cells = parseLspciCells(line)
  if (cells.length < 4) return undefined
  const klass = cells[1]?.toLowerCase() ?? ""
  if (!klass.includes("vga") && !klass.includes("3d") && !klass.includes("display")) return undefined
  const vendor = cells[2] ?? ""
  const device = cells[3] ?? ""
  const name = [vendor, device].filter(Boolean).join(" ").trim()
  if (!name) return undefined
  return { name, driver_version: null, vram_mb: null, pnp_device_id: cells[0] }
}

function parseLspciCells(line: string): string[] {
  // Split by spaces but preserve quoted segments.
  const cells: string[] = []
  let current = ""
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (!inQuote && ch === " ") {
      if (current.length > 0) {
        cells.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) cells.push(current)
  return cells
}

async function gatherLinuxGpu(signal: AbortSignal, timeoutMs: number): Promise<{ gpu: GpuInfo[]; warnings: string[] }> {
  const warnings: string[] = []
  const result = await runProcess("lspci", ["-mm"], signal, timeoutMs)
  if (result.code !== 0 && !result.stdout) {
    warnings.push(`gpu probe: lspci unavailable (${(result.stderr || "").slice(0, 120)})`)
    return { gpu: [], warnings }
  }
  const gpu: GpuInfo[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const row = parseLspciVgaLine(line.trim())
    if (row) gpu.push(row)
  }
  return { gpu, warnings }
}

async function gatherDarwinSystem(signal: AbortSignal, timeoutMs: number): Promise<{ system: SystemInfo; warnings: string[] }> {
  const warnings: string[] = []
  const result = await runProcess("system_profiler", ["SPHardwareDataType", "-json"], signal, timeoutMs)
  const data = safeJsonParse(result.stdout)
  const item = data?.SPHardwareDataType?.[0]
  if (!item) {
    warnings.push(`system probe: system_profiler SPHardwareDataType returned no data (code=${result.code})`)
    return {
      system: { manufacturer: "Apple", model: null, chassis_type: null, serial: null },
      warnings,
    }
  }
  return {
    system: {
      manufacturer: "Apple",
      model: item.machine_model ?? item.machine_name ?? null,
      chassis_type: item.machine_model?.toLowerCase().includes("book") ? "Notebook" : "Desktop",
      serial: item.serial_number ?? null,
      bios_vendor: "Apple",
      bios_version: item.boot_rom_version ?? null,
    },
    warnings,
  }
}

async function gatherDarwinGpu(signal: AbortSignal, timeoutMs: number): Promise<{ gpu: GpuInfo[]; warnings: string[] }> {
  const warnings: string[] = []
  const result = await runProcess("system_profiler", ["SPDisplaysDataType", "-json"], signal, timeoutMs)
  const data = safeJsonParse(result.stdout)
  const list = data?.SPDisplaysDataType
  if (!Array.isArray(list)) {
    warnings.push(`gpu probe: system_profiler SPDisplaysDataType returned no data (code=${result.code})`)
    return { gpu: [], warnings }
  }
  const gpu: GpuInfo[] = list.map((g) => ({
    name: g.sppci_model ?? g._name ?? "unknown",
    driver_version: g.spdisplays_metalfeatureset ?? null,
    vram_mb: parseVramString(g.spdisplays_vram_shared ?? g.spdisplays_vram),
    pnp_device_id: g.spdisplays_device_id ?? null,
  }))
  return { gpu, warnings }
}

function parseVramString(input: string | undefined | null): number | null {
  if (!input || typeof input !== "string") return null
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*(GB|MB|KB)?$/i)
  if (!m) return null
  const n = parseFloat(m[1] ?? "0")
  const unit = (m[2] ?? "MB").toUpperCase()
  if (unit === "GB") return Math.round(n * 1024)
  if (unit === "MB") return Math.round(n)
  if (unit === "KB") return Math.round(n / 1024)
  return null
}

async function gatherSystem(signal: AbortSignal, timeoutMs: number): Promise<{ system: SystemInfo; warnings: string[] }> {
  if (process.platform === "win32") return gatherWindowsSystem(signal, timeoutMs)
  if (process.platform === "darwin") return gatherDarwinSystem(signal, timeoutMs)
  if (process.platform === "linux") return gatherLinuxSystem()
  return {
    system: { manufacturer: null, model: null, chassis_type: null, serial: null },
    warnings: [`system probe: platform ${process.platform} not supported`],
  }
}

async function gatherGpu(signal: AbortSignal, timeoutMs: number): Promise<{ gpu: GpuInfo[]; warnings: string[] }> {
  if (process.platform === "win32") return gatherWindowsGpu(signal, timeoutMs)
  if (process.platform === "darwin") return gatherDarwinGpu(signal, timeoutMs)
  if (process.platform === "linux") return gatherLinuxGpu(signal, timeoutMs)
  return { gpu: [], warnings: [`gpu probe: platform ${process.platform} not supported`] }
}

function summariseTitle(meta: Metadata): string {
  const parts: string[] = []
  if (meta.os) parts.push(`${meta.os.platform} ${meta.os.release}`)
  if (meta.system?.model) {
    parts.push(`${meta.system.manufacturer ?? ""} ${meta.system.model}`.trim())
  }
  if (meta.cpu) parts.push(`${meta.cpu.cores}c CPU`)
  if (meta.memory) parts.push(`${(meta.memory.total_mb / 1024).toFixed(1)} GB RAM`)
  if (meta.gpu && meta.gpu.length > 0) parts.push(`GPU ${meta.gpu[0]!.name}`)
  return parts.join(" · ") || `system_info ${meta.action}`
}

function formatOutput(meta: Metadata): string {
  const lines: string[] = []
  if (meta.os) {
    lines.push(
      `OS: ${meta.os.platform} ${meta.os.release} (${meta.os.type} ${meta.os.version})`,
      `  arch=${meta.os.arch} hostname=${meta.os.hostname} user=${meta.os.user} uptime=${(meta.os.uptime_seconds / 3600).toFixed(1)}h`,
    )
  }
  if (meta.system) {
    lines.push(
      `System: ${meta.system.manufacturer ?? "?"} ${meta.system.model ?? "?"} (chassis=${meta.system.chassis_type ?? "?"})`,
    )
    if (meta.system.serial) lines.push(`  serial=${meta.system.serial}`)
    if (meta.system.bios_vendor || meta.system.bios_version)
      lines.push(`  bios=${meta.system.bios_vendor ?? "?"} ${meta.system.bios_version ?? ""}`.trim())
  }
  if (meta.cpu) {
    lines.push(`CPU: ${meta.cpu.model} (${meta.cpu.cores} cores, ${meta.cpu.speed_ghz} GHz, arch=${meta.cpu.arch})`)
    if (meta.cpu.loadavg_1m !== undefined && process.platform !== "win32") {
      lines.push(`  loadavg=${meta.cpu.loadavg_1m.toFixed(2)} ${meta.cpu.loadavg_5m?.toFixed(2)} ${meta.cpu.loadavg_15m?.toFixed(2)}`)
    }
  }
  if (meta.memory) {
    lines.push(
      `Memory: ${(meta.memory.total_mb / 1024).toFixed(1)} GB total, ${(meta.memory.free_mb / 1024).toFixed(1)} GB free (${meta.memory.percent_used}% used)`,
    )
  }
  if (meta.gpu && meta.gpu.length > 0) {
    lines.push(`GPU:`)
    for (const g of meta.gpu) {
      const vram = g.vram_mb ? ` ${g.vram_mb} MB` : ""
      const drv = g.driver_version ? ` driver=${g.driver_version}` : ""
      lines.push(`  - ${g.name}${vram}${drv}`)
    }
  }
  if (meta.network && meta.network.length > 0) {
    lines.push(`Network:`)
    for (const n of meta.network) {
      const tag = n.internal ? " (internal)" : ""
      lines.push(`  - ${n.name}${tag}: ipv4=${n.ipv4 ?? "-"} ipv6=${n.ipv6 ?? "-"} mac=${n.mac ?? "-"}`)
    }
  }
  if (meta.warnings && meta.warnings.length > 0) {
    lines.push(`Warnings:`)
    for (const w of meta.warnings) lines.push(`  ! ${w}`)
  }
  return lines.join("\n")
}

const NEEDS_OS = (a: Action) => a === "os" || a === "summary" || a === "all"
const NEEDS_CPU = (a: Action) => a === "cpu" || a === "summary" || a === "all"
const NEEDS_MEM = (a: Action) => a === "memory" || a === "summary" || a === "all"
const NEEDS_SYSTEM = (a: Action) => a === "system" || a === "summary" || a === "all"
const NEEDS_GPU = (a: Action) => a === "gpu" || a === "summary" || a === "all"
const NEEDS_NET = (a: Action) => a === "network" || a === "all"

export const SystemInfoTool = Tool.define(
  "system_info",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action ?? "summary"
          const timeoutMs = params.timeout_ms ?? 8_000
          const start = Date.now()
          const warnings: string[] = []

          const meta: Metadata = {
            action,
            platform: process.platform,
            elapsed_ms: 0,
          }

          if (NEEDS_OS(action)) meta.os = gatherOs()
          if (NEEDS_CPU(action)) meta.cpu = gatherCpu()
          if (NEEDS_MEM(action)) meta.memory = gatherMemory()
          if (NEEDS_NET(action)) meta.network = gatherNetwork()

          const probes: Array<Promise<void>> = []
          if (NEEDS_SYSTEM(action)) {
            probes.push(
              gatherSystem(ctx.abort, timeoutMs).then((res) => {
                meta.system = res.system
                warnings.push(...res.warnings)
              }),
            )
          }
          if (NEEDS_GPU(action)) {
            probes.push(
              gatherGpu(ctx.abort, timeoutMs).then((res) => {
                meta.gpu = res.gpu
                warnings.push(...res.warnings)
              }),
            )
          }
          if (probes.length > 0) yield* Effect.promise(() => Promise.all(probes))

          if (warnings.length > 0) meta.warnings = warnings
          meta.elapsed_ms = Date.now() - start

          return done({
            title: summariseTitle(meta),
            metadata: meta,
            output: formatOutput(meta),
          })
        }),
    }
  }),
)

export const __testing = {
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
}
