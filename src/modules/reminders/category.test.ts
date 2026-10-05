import { describe, expect, it } from 'vitest'
import { CATEGORY_LIST, CATEGORY_META, categoryMeta } from './category'

describe('分类元数据', () => {
  it('四个分类都有中文名、语义图标与色条，不允许缺项', () => {
    // 少一个分类，弹窗里就会出现没有颜色、没有图标的提醒
    for (const c of ['work', 'logistics', 'service', 'personal'] as const) {
      const m = categoryMeta(c)
      expect(m.label).toBeTruthy()
      expect(m.icon).toBeTruthy()
      expect(m.bar).toMatch(/^bg-/)
    }
  })

  it('色条两两不同，分类靠颜色就能分开', () => {
    const bars = CATEGORY_LIST.map((c) => CATEGORY_META[c].bar)
    expect(new Set(bars).size).toBe(bars.length)
  })

  it('CATEGORY_LIST 顺序稳定：工作、物流、客服、个人', () => {
    expect(CATEGORY_LIST).toEqual(['work', 'logistics', 'service', 'personal'])
  })
})
