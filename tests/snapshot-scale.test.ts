import { describe, expect, it } from 'vitest'
import { niceScale } from '../src/ui/Snapshot.js'

/**
 * The Company Snapshot axis rule: the axis never starts above zero, extends
 * below zero when the data does, and lands on clean tick steps.
 */
describe('snapshot axis scale', () => {
  it('runs from zero to a rounded top for all-positive data', () => {
    const { top, bottom, ticks } = niceScale(9.0, 3.1)
    expect(bottom).toBe(0)
    expect(top).toBeGreaterThanOrEqual(9.0)
    expect(ticks[0]).toBe(0)
    // Clean steps, not quarter-of-max fractions.
    const step = ticks[1]! - ticks[0]!
    expect([1, 2, 2.5, 5, 10].some((s) => {
      const mag = 10 ** Math.floor(Math.log10(step))
      return Math.abs(step - s * mag) < 1e-9
    })).toBe(true)
  })

  it('extends below zero when a value is negative, keeping the zero line', () => {
    const { top, bottom, ticks } = niceScale(0.45, -0.15)
    expect(bottom).toBeLessThanOrEqual(-0.15)
    expect(top).toBeGreaterThanOrEqual(0.45)
    expect(ticks.some((t) => Math.abs(t) < 1e-9)).toBe(true) // zero is a tick
  })

  it('tops out at exactly zero when every value is negative', () => {
    const { top, bottom } = niceScale(-0.05, -0.4)
    expect(top).toBe(0) // the axis never starts above zero
    expect(bottom).toBeLessThanOrEqual(-0.4)
  })

  it('degrades sanely when all values are zero', () => {
    const { top, bottom } = niceScale(0, 0)
    expect(bottom).toBe(0)
    expect(top).toBeGreaterThan(0)
  })
})
