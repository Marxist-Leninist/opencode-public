import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { LatLonTool, __testing } from "../../src/tool/latlon"
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

const LON: { lat: number; lon: number } = { lat: 51.5074, lon: -0.1278 }
const NY: { lat: number; lon: number } = { lat: 40.7128, lon: -74.006 }
const SF: { lat: number; lon: number } = { lat: 37.7749, lon: -122.4194 }

describe("tool.latlon helpers", () => {
  test("haversine London-New York ~5570 km", () => {
    const km = __testing.haversineKm(LON, NY)
    expect(km).toBeGreaterThan(5560)
    expect(km).toBeLessThan(5580)
  })

  test("haversine NYC-SF ~4129 km", () => {
    const km = __testing.haversineKm(NY, SF)
    expect(km).toBeGreaterThan(4120)
    expect(km).toBeLessThan(4140)
  })

  test("vincenty close to haversine for short distances", () => {
    // Short distance: 1 degree north at the equator is about 111 km.
    const v = __testing.vincentyMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })
    expect(v.converged).toBe(true)
    expect(v.distance / 1000).toBeGreaterThan(110)
    expect(v.distance / 1000).toBeLessThan(112)
  })

  test("bearing London to NY initial about 288 deg (WNW)", () => {
    const b = __testing.bearingDeg(LON, NY)
    expect(b).toBeGreaterThan(285)
    expect(b).toBeLessThan(295)
  })

  test("bearing NY to London initial about 51 deg", () => {
    const b = __testing.bearingDeg(NY, LON)
    expect(b).toBeGreaterThan(48)
    expect(b).toBeLessThan(54)
  })

  test("midpoint LON-NY is in the North Atlantic", () => {
    const m = __testing.midpoint(LON, NY)
    expect(m.lat).toBeGreaterThan(45)
    expect(m.lat).toBeLessThan(60)
    expect(m.lon).toBeLessThan(-30)
    expect(m.lon).toBeGreaterThan(-50)
  })

  test("destination from London 100km east lands about +1.45 deg east", () => {
    const d = __testing.destinationPoint(LON, 90, 100)
    expect(Math.abs(d.lat - LON.lat)).toBeLessThan(0.05)
    expect(d.lon).toBeGreaterThan(LON.lon + 1.3)
    expect(d.lon).toBeLessThan(LON.lon + 1.6)
  })

  test("round-trip: A to bearing/distance to destination is near B", () => {
    const distKm = __testing.haversineKm(LON, NY)
    const brg = __testing.bearingDeg(LON, NY)
    const d = __testing.destinationPoint(LON, brg, distKm)
    expect(Math.abs(d.lat - NY.lat)).toBeLessThan(0.5)
    expect(Math.abs(d.lon - NY.lon)).toBeLessThan(0.5)
  })

  test("bbox 5km around London is roughly +/- 0.045 lat", () => {
    const box = __testing.bboxAround(LON, 5)
    const dLat = box.max.lat - box.min.lat
    expect(dLat).toBeGreaterThan(0.08)
    expect(dLat).toBeLessThan(0.10)
  })

  test("bbox crosses antimeridian when near 180 deg", () => {
    const box = __testing.bboxAround({ lat: 0, lon: 179.95 }, 50)
    expect(box.crosses_antimeridian).toBe(true)
    expect(box.min.lon).toBeGreaterThan(0)
    expect(box.max.lon).toBeLessThan(0)
  })

  test("validate", () => {
    expect(__testing.validateLatLon(0, 0)).toBe(true)
    expect(__testing.validateLatLon(90, 180)).toBe(true)
    expect(__testing.validateLatLon(91, 0)).toBe(false)
    expect(__testing.validateLatLon(0, 181)).toBe(false)
    expect(__testing.validateLatLon(NaN, 0)).toBe(false)
  })

  test("parseCoordinate decimal, comma, hemispheres, DMS", () => {
    expect(__testing.parseCoordinate("51.5074, -0.1278")).toEqual({ lat: 51.5074, lon: -0.1278 })
    expect(__testing.parseCoordinate("51.5074N, 0.1278W")).toEqual({ lat: 51.5074, lon: -0.1278 })
    const dms = __testing.parseCoordinate("51\u00b030'27\"N 0\u00b007'40\"W")
    expect(dms.lat).toBeGreaterThan(51.5)
    expect(dms.lat).toBeLessThan(51.51)
    expect(dms.lon).toBeLessThan(-0.12)
    expect(dms.lon).toBeGreaterThan(-0.13)
  })

  test("parseCoordinate treats deg as a unit, not an east marker", () => {
    const dms = __testing.parseCoordinate("51 deg 30 27 N, 0 deg 07 40 W")
    expect(dms.lat).toBeGreaterThan(51.5)
    expect(dms.lat).toBeLessThan(51.51)
    expect(dms.lon).toBeLessThan(-0.12)
    expect(dms.lon).toBeGreaterThan(-0.13)
  })

  test("parseCoordinate rejects wrong hemisphere and invalid DMS ranges", () => {
    expect(() => __testing.parseCoordinate("51.5E, 0.1W")).toThrow()
    expect(() => __testing.parseCoordinate("51 60 0 N, 0 0 0 W")).toThrow()
    expect(() => __testing.parseCoordinate("51 0 0 N S, 0 0 0 W")).toThrow()
  })

  test("formatCoordinate decimal & dms", () => {
    expect(__testing.formatCoordinate({ lat: 51.5074, lon: -0.1278 }, "decimal", 4)).toBe("51.5074, -0.1278")
    const out = __testing.formatCoordinate({ lat: 51.5074, lon: -0.1278 }, "dms", 6)
    expect(out).toContain("N")
    expect(out).toContain("W")
  })

  test("unit conversions are exact", () => {
    expect(__testing.unitToKm(1, "mi")).toBeCloseTo(1.609344, 6)
    expect(__testing.kmToUnit(1.609344, "mi")).toBeCloseTo(1, 6)
    expect(__testing.unitToKm(1000, "m")).toBe(1)
    expect(__testing.kmToUnit(1, "m")).toBe(1000)
  })
})

describe("tool.latlon execute", () => {
  it.live("distance haversine", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* LatLonTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "distance", from: LON, to: NY }, baseCtx)
        expect(r.metadata.algorithm).toBe("haversine")
        expect(r.metadata.distance!).toBeGreaterThan(5560)
        expect(r.metadata.distance!).toBeLessThan(5580)
      }),
    ),
  )

  it.live("distance vincenty", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* LatLonTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          { action: "distance", from: LON, to: NY, algorithm: "vincenty" },
          baseCtx,
        )
        expect(r.metadata.algorithm === "vincenty" || r.metadata.algorithm === "haversine_fallback").toBe(true)
        expect(r.metadata.distance!).toBeGreaterThan(5500)
        expect(r.metadata.distance!).toBeLessThan(5600)
      }),
    ),
  )

  it.live("bearing initial vs final", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* LatLonTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "bearing", from: LON, to: NY }, baseCtx)
        // Initial bearing London to NY is WNW.
        expect(r.metadata.initial_bearing!).toBeGreaterThan(280)
        expect(r.metadata.final_bearing!).toBeLessThan(280)
      }),
    ),
  )

  it.live("destination", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* LatLonTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          { action: "destination", from: LON, bearing: 90, distance: 100, unit: "km" },
          baseCtx,
        )
        const d = r.metadata.destination!
        expect(Math.abs(d.lat - LON.lat)).toBeLessThan(0.05)
        expect(d.lon).toBeGreaterThan(LON.lon + 1.3)
      }),
    ),
  )

  it.live("parse string then format", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* LatLonTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "parse", value: "40.7128 N, 74.0060 W" }, baseCtx)
        expect(r.metadata.point!.lat).toBeCloseTo(40.7128, 4)
        expect(r.metadata.point!.lon).toBeCloseTo(-74.006, 4)
      }),
    ),
  )

  it.live("bbox around equator", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* LatLonTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "bbox", from: { lat: 0, lon: 0 }, distance: 100 }, baseCtx)
        const box = r.metadata.bbox!
        expect(box.min.lat).toBeLessThan(0)
        expect(box.max.lat).toBeGreaterThan(0)
        expect(box.crosses_antimeridian).toBeFalsy()
      }),
    ),
  )

  it.live("validate good and bad", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* LatLonTool
        const tool = yield* ti.init()
        const ok = yield* tool.execute({ action: "validate", lat: 0, lon: 0 }, baseCtx)
        expect(ok.metadata.ok).toBe(true)
        const bad = yield* tool.execute({ action: "validate", lat: 91, lon: 0 }, baseCtx)
        expect(bad.metadata.ok).toBe(false)
      }),
    ),
  )

  it.live("string input parsed via from/to", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* LatLonTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          { action: "distance", from: "51.5074, -0.1278", to: "40.7128, -74.0060" },
          baseCtx,
        )
        expect(r.metadata.distance!).toBeGreaterThan(5560)
        expect(r.metadata.distance!).toBeLessThan(5580)
      }),
    ),
  )
})
