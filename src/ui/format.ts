import { NM, type Multiple } from '../lib/metrics.js'

/** Display helpers. Every formatter renders missing data as an em dash. */

export const EMPTY = '—'

export function formatMultiple(value: Multiple, digits = 1): string {
  if (value === NM) return 'nm'
  if (value === null) return EMPTY
  return `${value.toFixed(digits)}x`
}

export function formatPercent(value: Multiple, digits = 1): string {
  if (value === NM) return 'nm'
  if (value === null) return EMPTY
  return `${(value * 100).toFixed(digits)}%`
}

/** Money in millions, abbreviated to billions once it stops being readable. */
export function formatMillions(value: number | null): string {
  if (value === null) return EMPTY
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}T`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}B`
  return `${sign}$${abs.toFixed(0)}M`
}

export function formatPrice(value: number | null): string {
  return value === null ? EMPTY : `$${value.toFixed(2)}`
}

export function formatNumber(value: number | null, digits = 2): string {
  return value === null ? EMPTY : value.toFixed(digits)
}

/**
 * Master-grid money: `$1,250` for millions figures, `$10.25` when cents are
 * the point (per-share numbers). Same conventions as the Master Input grid.
 */
export function formatDollars(value: number | null | undefined, cents = false): string {
  if (value === null || value === undefined) return EMPTY
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  return `${sign}$${abs.toLocaleString('en-US', cents
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 0 })}`
}

/** A plain count with commas and no decimals, as the Master Input grid shows shares. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY
  const sign = value < 0 ? '-' : ''
  return `${sign}${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

/** Signed percentage, for returns where direction is the point. */
export function formatReturn(value: number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY
  const pct = (value * 100).toFixed(1)
  return value > 0 ? `+${pct}%` : `${pct}%`
}

/** Rough age of a timestamp, for the "FactSet as of" readout. */
export function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleString()
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
