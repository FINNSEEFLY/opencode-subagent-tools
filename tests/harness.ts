import { afterEach } from "bun:test"
import plugin from "../src/index"
import { CHILD_STATUSES } from "../src/status"

export type Event = Record<string, any>

export interface HarnessOptions {
  options?: Record<string, any>
  sessionList?: (input: any, options?: any) => Promise<any>
  noSessionList?: boolean
  eventError?: Error
  eventFailures?: number
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export function makeHarness(input: HarnessOptions = {}) {
  const sessions = new Map<string, any>()
  const tools = new Map<string, any>()
  const skills = new Map<string, any>()
  const namespaces: any[] = []
  const calls = {
    prompt: [] as any[],
    synthetic: [] as any[],
    interrupt: [] as any[],
    permission: [] as any[],
  }
  const sessionListCalls: any[] = []
  const eventSubscribeCalls: any[] = []

  const queue: Event[] = []
  const waiters: Array<(result: IteratorResult<Event>) => void> = []

  const sessionListImpl = input.sessionList
  let sequence = 0
  let remainingEventFailures =
    input.eventFailures ?? (input.eventError ? Number.POSITIVE_INFINITY : 0)

  const defaultSessionList = async (value: any) => {
    const all = [...sessions.values()].filter(
      (session) => session.parentID === value.parentID,
    )
    const start = value.cursor ? Number(value.cursor) : 0
    const limit = value.limit ?? 100
    const page = all.slice(start, start + limit)
    const next = start + limit < all.length ? String(start + limit) : undefined
    return { data: page, cursor: next ? { next } : {} }
  }

  const sessionList = async (value: any, options?: any) => {
    sessionListCalls.push(value)
    return sessionListImpl ? sessionListImpl(value, options) : defaultSessionList(value)
  }

  const toolEditor = {
    namespace: (value: any) => {
      namespaces.push(value)
    },
    add: (tool: any) => tools.set(tool.name, tool),
    update: () => undefined,
    remove: () => undefined,
    list: () => [],
    get: () => undefined,
  }

  const ctx: any = {
    options: input.options ?? {},
    tool: {
      transform: async (callback: (toolEditor: any) => void) => {
        callback(toolEditor)
        return { dispose: async () => tools.clear() }
      },
    },
    session: {
      list: sessionList,
      get: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID),
      prompt: async (value: any) => {
        calls.prompt.push(value)
        return { id: "inbox_user" }
      },
      synthetic: async (value: any) => {
        calls.synthetic.push(value)
        return { id: "inbox_synthetic" }
      },
      context: async () => [],
      interrupt: async (value: any) => {
        calls.interrupt.push(value)
        const current = sessions.get(value.sessionID)
        if (current) {
          sessions.set(value.sessionID, {
            ...current,
            outcome: "interrupted",
            time: { ...current.time, idle: current.time.updated },
          })
        }
        return { interrupted: true }
      },
    },
    permission: {
      assert: async (value: any) => {
        calls.permission.push(value)
      },
    },
    model: {
      list: async () => ({ data: [] }),
      default: async () => undefined,
    },
    skill: {
      list: async () => [...skills.values()],
      reload: async () => undefined,
      transform: async (callback: (skillEditor: any) => void) => {
        const skillEditor = {
          list: () => [...skills.values()],
          get: (id: string) => skills.get(id),
          add: (skill: any) => skills.set(skill.id, skill),
          update: (id: string, update: (skill: any) => void) => {
            const current = skills.get(id)
            if (current) update(current)
          },
          remove: (id: string) => skills.delete(id),
        }
        callback(skillEditor)
        return { dispose: async () => skills.clear() }
      },
    },
    event: {
      subscribe: async function* (options: {
        signal: AbortSignal
        types?: readonly string[]
        onActivity?: () => void
      }) {
        eventSubscribeCalls.push(options)
        const { signal } = options
        if (remainingEventFailures > 0) {
          remainingEventFailures--
          throw input.eventError ?? new Error("event stream failed")
        }
        while (!signal.aborted) {
          if (queue.length > 0) {
            yield queue.shift()
            continue
          }
          const next = await new Promise<IteratorResult<Event>>((resolve) => {
            waiters.push(resolve)
            signal.addEventListener(
              "abort",
              () => resolve({ done: true, value: undefined }),
              { once: true },
            )
          })
          if (next.done) return
          yield next.value
        }
      },
    },
  }

  if (input.noSessionList) delete (ctx.session as any).list

  const emit = (event: Event) => {
    if (event.type === "session.created") {
      const data = event.data ?? {}
      if (data.sessionID && !sessions.has(data.sessionID)) {
        sequence++
        sessions.set(data.sessionID, {
          id: data.sessionID,
          parentID: data.parentID,
          agent: data.agent,
          title: data.title,
          time: { created: sequence, updated: sequence },
        })
      }
    }
    const waiter = waiters.shift()
    if (waiter) waiter({ done: false, value: event })
    else queue.push(event)
  }

  const addSession = (
    id: string,
    parentID: string,
    overrides: Record<string, any> = {},
  ) => {
    sequence++
    const { time, ...rest } = overrides
    const info = {
      id,
      parentID,
      agent: "general",
      title: `Task ${id}`,
      ...rest,
      time: { created: sequence, updated: sequence, busy: sequence, ...time },
    }
    sessions.set(id, info)
    return info
  }

  const setup = async () => (await plugin.setup(ctx)) as () => Promise<void>

  return {
    ctx,
    sessions,
    tools,
    skills,
    calls,
    sessionListCalls,
    eventSubscribeCalls,
    namespaces,
    emit,
    tick,
    setup,
    addSession,
  }
}

export type Harness = ReturnType<typeof makeHarness>

export const ALL_STATUSES = [...CHILD_STATUSES]

export const createChild = (
  h: Harness,
  id: string,
  parentID: string,
  agent = "general",
  title = "Task",
) => h.addSession(id, parentID, { agent, title })

export const hasUndefined = (value: unknown): boolean => {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.some(hasUndefined)
  if (value && typeof value === "object") return Object.values(value).some(hasUndefined)
  return false
}

export const startChild = (h: Harness, id: string) => {
  h.emit({ type: "session.execution.started", data: { sessionID: id } })
}

export const sessionInfo = (
  id: string,
  parentID: string,
  overrides: Record<string, any> = {},
) => {
  const { time, ...rest } = overrides
  return {
    id,
    parentID,
    agent: "general",
    title: `Task ${id}`,
    ...rest,
    time: { created: 1, updated: 2, busy: 1, ...time },
  }
}

export const listOf = (result: { content: string }, id: string): string | undefined =>
  result.content.split("\n").find((line) => line.startsWith(id))

export const cursorOf = (result: { content: string }): string | undefined =>
  result.content.match(/[Uu]se cursor (\S+)/)?.[1]

export const waitFor = async <T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 3000,
): Promise<T> => {
  const deadline = Date.now() + timeout
  let value = await read()
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    value = await read()
  }
  return value
}

export const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})
