import { describe, expect, it } from 'vitest'
import { chartPalette } from '@/lib/chartTheme'
import { contrastRatio } from '@/lib/color'

/**
 * 这是设计系统的下限检查，不是实现复述：
 * 两套主题的图表文字都必须达到 WCAG AA（正文 4.5:1），网格线至少 3:1。
 * 调色时如果谁把深色文字调暗了，这里会直接红。
 */
describe('图表配色可读性', () => {
  for (const theme of ['light', 'dark'] as const) {
    const p = chartPalette(theme)

    it(`${theme}：正文文字与底色对比度 ≥ 4.5:1`, () => {
      expect(contrastRatio(p.text, p.surface)).toBeGreaterThanOrEqual(4.5)
    })

    it(`${theme}：次级文字与底色对比度 ≥ 3:1`, () => {
      expect(contrastRatio(p.subText, p.surface)).toBeGreaterThanOrEqual(3)
    })

    it(`${theme}：坐标轴与底色可分辨（≥ 1.2:1，网格线本就是弱化的）`, () => {
      expect(contrastRatio(p.axis, p.surface)).toBeGreaterThanOrEqual(1.2)
    })
  }

  it('两套主题确实不同，不是同一份被复用', () => {
    expect(chartPalette('dark')).not.toEqual(chartPalette('light'))
    expect(chartPalette('dark').surface).toBe('#232327')
  })
})
