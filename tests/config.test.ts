import { describe, expect, test } from "bun:test"
import { LIMIT_KEYS, LIMIT_SPECS, resolveConfig } from "../src/config"

describe("config limits", () => {
  test("defaults come from LIMIT_SPECS", () => {
    const config = resolveConfig({})
    for (const key of LIMIT_KEYS) {
      expect(config.limits[key]).toBe(LIMIT_SPECS[key].default)
    }
  })

  test("clamps, floors, and falls back for invalid limits", () => {
    const config = resolveConfig({
      limits: {
        maxDiscoveryNodes: 0,
        maxDiscoveryDepth: 2.9,
        maxDiscoveryPages: 999,
        maxListRows: -1,
        maxCancelBatch: "many",
        maxTextLength: 999999,
      },
    })

    expect(config.limits.maxDiscoveryNodes).toBe(1)
    expect(config.limits.maxDiscoveryDepth).toBe(2)
    expect(config.limits.maxDiscoveryPages).toBe(50)
    expect(config.limits.maxListRows).toBe(1)
    expect(config.limits.maxCancelBatch).toBe(20)
    expect(config.limits.maxTextLength).toBe(32000)
  })

  test("ignores unknown limit keys", () => {
    const config = resolveConfig({
      limits: { maxListRows: 3, unknownLimit: 999 },
    })
    expect(config.limits.maxListRows).toBe(3)
    expect("unknownLimit" in config.limits).toBe(false)
  })
})
