export const TOOL = {
  list: "list",
  cancel: "cancel",
  cancelDescendants: "cancel_descendants",
  steer: "steer",
  queue: "queue",
  context: "context",
  usage: "usage",
} as const

export type ToolName = (typeof TOOL)[keyof typeof TOOL]
