import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/unit"

const { convert, convertTemperature, fuelToKml, fuelFromKml, normalizeUnit, findCategory } = __testing

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b))

describe("tool.unit basics", () => {
  test("length: km to mi", () => {
    const { result, category } = convert(10, "km", "mi")
    expect(category).toBe("length")
    expect(close(result, 6.21371192237334, 1e-9)).toBe(true)
  })

  test("length: ft to in identity-by-factor", () => {
    expect(convert(1, "ft", "in").result).toBeCloseTo(12, 9)
    expect(convert(1, "yd", "ft").result).toBeCloseTo(3, 9)
    expect(convert(1, "mi", "ft").result).toBeCloseTo(5280, 9)
  })

  test("mass: lb <-> kg classic", () => {
    expect(convert(1, "lb", "kg").result).toBeCloseTo(0.45359237, 12)
    expect(convert(1, "kg", "lb").result).toBeCloseTo(2.2046226218487757, 12)
  })

  test("mass: alias 'pounds' resolves to lb", () => {
    expect(normalizeUnit("pounds")).toBe("lb")
    expect(convert(1, "pounds", "kg").result).toBeCloseTo(0.45359237, 12)
  })

  test("volume: 1 US gal = 3.785411784 L", () => {
    expect(convert(1, "gal_us", "L").result).toBeCloseTo(3.785411784, 12)
    expect(convert(1, "tbsp", "tsp").result).toBeCloseTo(3, 9)
  })

  test("temperature: round-trip C->F->C and known points", () => {
    expect(convertTemperature(0, "C", "F")).toBeCloseTo(32, 9)
    expect(convertTemperature(100, "C", "F")).toBeCloseTo(212, 9)
    expect(convertTemperature(-40, "C", "F")).toBeCloseTo(-40, 9)
    expect(convertTemperature(0, "C", "K")).toBeCloseTo(273.15, 9)
    expect(convertTemperature(491.67, "R", "F")).toBeCloseTo(32, 6)
    // Round-trip
    for (const c of [-273.15, -100, 0, 25, 100, 1000]) {
      const f = convertTemperature(c, "C", "F")
      expect(convertTemperature(f, "F", "C")).toBeCloseTo(c, 9)
    }
  })

  test("time: hours to seconds", () => {
    expect(convert(1, "h", "s").result).toBe(3600)
    expect(convert(1, "d", "h").result).toBe(24)
    expect(convert(1, "wk", "d").result).toBe(7)
  })

  test("data: KB vs KiB are different", () => {
    expect(convert(1, "KB", "B").result).toBe(1000)
    expect(convert(1, "KiB", "B").result).toBe(1024)
    expect(convert(1, "GiB", "MiB").result).toBe(1024)
    expect(convert(1, "B", "bit").result).toBe(8)
  })

  test("speed: kmh <-> mph", () => {
    expect(convert(100, "kmh", "mph").result).toBeCloseTo(62.13711922373339, 9)
    expect(convert(60, "mph", "kmh").result).toBeCloseTo(96.56064, 9)
    expect(convert(1, "knot", "mph").result).toBeCloseTo(1.150779448023543, 9)
  })

  test("area: ha and acre", () => {
    expect(convert(1, "ha", "m2").result).toBe(10000)
    expect(convert(1, "ac", "m2").result).toBeCloseTo(4046.8564224, 9)
    expect(convert(1, "km2", "ha").result).toBe(100)
  })

  test("pressure: psi to kPa, atm to Pa", () => {
    expect(convert(1, "psi", "Pa").result).toBeCloseTo(6894.757293168, 6)
    expect(convert(1, "atm", "Pa").result).toBe(101325)
    expect(convert(760, "torr", "atm").result).toBeCloseTo(1, 12)
  })

  test("energy/power", () => {
    expect(convert(1, "kWh", "J").result).toBe(3.6e6)
    expect(convert(1, "kcal", "cal").result).toBe(1000)
    expect(convert(1, "hp", "W").result).toBeCloseTo(745.6998715822702, 9)
  })

  test("angle: deg/rad/turn", () => {
    expect(convert(180, "deg", "rad").result).toBeCloseTo(Math.PI, 12)
    expect(convert(1, "turn", "deg").result).toBeCloseTo(360, 12)
    expect(convert(1, "deg", "arcmin").result).toBeCloseTo(60, 12)
  })

  test("frequency: Hz/kHz/rpm", () => {
    expect(convert(1, "kHz", "Hz").result).toBe(1000)
    expect(convert(60, "rpm", "Hz").result).toBe(1)
  })

  test("fuel_economy: mpg_us <-> l_100km classic", () => {
    // 30 mpg_us is approximately 7.84 l/100km (well-known approximation)
    const r = convert(30, "mpg_us", "l_100km").result
    expect(r).toBeCloseTo(7.84049, 4)
    // Inverse round-trip
    const back = convert(r, "l_100km", "mpg_us").result
    expect(back).toBeCloseTo(30, 9)
  })

  test("fuel_economy: kml is identity", () => {
    expect(fuelToKml(10, "kml")).toBe(10)
    expect(fuelFromKml(10, "kml")).toBe(10)
  })

  test("findCategory + cross-category rejected", () => {
    expect(findCategory("kg")).toBe("mass")
    expect(findCategory("Pa")).toBe("pressure")
    expect(() => convert(1, "kg", "m")).toThrow(/not the same category/)
    expect(() => convert(1, "fzz", "kg")).toThrow(/unknown source/)
    expect(() => convert(1, "kg", "qux")).toThrow(/unknown target/)
  })

  test("non-finite value rejected", () => {
    expect(() => convert(NaN, "m", "ft")).toThrow(/finite/)
    expect(() => convert(Infinity, "m", "ft")).toThrow(/finite/)
  })

  test("l_100km of zero is rejected", () => {
    expect(() => convert(0, "l_100km", "mpg_us")).toThrow()
  })
})
