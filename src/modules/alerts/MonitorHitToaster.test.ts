import { describe, expect, it } from 'vitest'
import { detectNewHits, shouldBeep } from '@/modules/alerts/MonitorHitToaster'
import type { HitEvent } from '@/lib/hitEvents'
import type { RoundGroup } from '@/modules/alerts/hitGrouping'

describe('detectNewHits', () => {
  it('首次空集合返回全部为新', () => {
    expect(detectNewHits(new Set(), [{ id: 1 }, { id: 2 }])).toEqual([1, 2])
  })

  it('已见的不算新', () => {
    expect(detectNewHits(new Set([1, 2]), [{ id: 1 }, { id: 2 }, { id: 3 }])).toEqual([3])
  })

  it('无新命中返回空', () => {
    expect(detectNewHits(new Set([1, 2, 3]), [{ id: 1 }, { id: 2 }])).toEqual([])
  })

  it('顺序保持输入顺序', () => {
    expect(detectNewHits(new Set([1]), [{ id: 1 }, { id: 5 }, { id: 3 }])).toEqual([5, 3])
  })
})

function grp(level: string): RoundGroup {
  return {
    representative: { tool: 'monitor', level, matchedBy: 'image' } as unknown as HitEvent,
    events: [],
    count: 1,
    aggregated: false,
  }
}

describe('shouldBeep', () => {
  /*
   * 提示音要按「本轮最新那一组」的级别决定，而不是闭包里那个初次渲染的 group
   * （它恒为 null → 级别恒为 info → 永远不响）。
   */
  it('alert 级要响', () => {
    expect(shouldBeep(grp('alert'))).toBe(true)
  })

  it('warn 级要响', () => {
    expect(shouldBeep(grp('warn'))).toBe(true)
  })

  it('info 级不打扰', () => {
    expect(shouldBeep(grp('info'))).toBe(false)
  })

  it('没有新命中就不响', () => {
    expect(shouldBeep(null)).toBe(false)
    expect(shouldBeep(undefined)).toBe(false)
  })
})
