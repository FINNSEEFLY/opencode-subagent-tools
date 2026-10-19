import { describe, expect, test } from "bun:test"
import { EVENT, EVENT_META, EVENT_TYPES, TERMINAL_EVENT_STATUS } from "../src/events"

describe("event registry", () => {
  test("covers every subscribed event", () => {
    expect([...EVENT_TYPES].toSorted()).toEqual(Object.values(EVENT).toSorted())
    for (const type of Object.values(EVENT)) {
      expect(EVENT_META[type]).toBeDefined()
    }
  })

  test("derives terminal statuses from the registry", () => {
    expect(TERMINAL_EVENT_STATUS.get(EVENT.executionSucceeded)).toBe("finished")
    expect(TERMINAL_EVENT_STATUS.get(EVENT.executionFailed)).toBe("failed")
    expect(TERMINAL_EVENT_STATUS.get(EVENT.executionInterrupted)).toBe("stopped")
    expect(TERMINAL_EVENT_STATUS.get(EVENT.deleted)).toBe("stopped")
    expect(TERMINAL_EVENT_STATUS.get(EVENT.idle)).toBe("unknown")
    expect(TERMINAL_EVENT_STATUS.has(EVENT.executionStarted)).toBe(false)
    expect(TERMINAL_EVENT_STATUS.has(EVENT.status)).toBe(false)
  })
})
