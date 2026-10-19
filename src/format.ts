const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600

export const compactNumber = (value: number): string => {
  if (!Number.isFinite(value)) return "0"
  if (Math.abs(value) >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Math.round(millions * 10) / 10}m`
  }
  if (Math.abs(value) >= 1_000) {
    const thousands = Math.round(value / 1_000)
    if (Math.abs(thousands) >= 1_000) {
      const millions = value / 1_000_000
      return `${Math.round(millions * 10) / 10}m`
    }
    return `${thousands}k`
  }
  return String(Math.round(value))
}

export const formatCost = (value: number): string =>
  value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`

export const age = (from: number): string => {
  const total = Math.max(0, Math.floor((Date.now() - from) / MILLISECONDS_PER_SECOND))
  if (total < SECONDS_PER_MINUTE) return `${total}s`
  const minutes = Math.floor(total / SECONDS_PER_MINUTE)
  if (minutes < SECONDS_PER_HOUR) return `${minutes}m`
  return `${Math.floor(minutes / SECONDS_PER_MINUTE)}h`
}

export const ageSeconds = (from: number): number =>
  Math.max(0, Math.floor((Date.now() - from) / MILLISECONDS_PER_SECOND))
