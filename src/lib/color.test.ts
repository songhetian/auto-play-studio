import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToRgb, relativeLuminance } from '@/lib/color'

/** 期望值取自 WCAG 2.1 的定义本身（黑白对比度恒为 21:1、纯黑亮度 0、纯白亮度 1） */
describe('对比度计算', () => {
  it('解析 3 位与 6 位 hex', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255])
    expect(hexToRgb('#165DFF')).toEqual([22, 93, 255])
    expect(hexToRgb('000000')).toEqual([0, 0, 0])
  })

  it('纯黑亮度 0、纯白亮度 1', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5)
  })

  it('黑白对比度是极值 21:1，同色是 1:1', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1)
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5)
  })

  it('与参数顺序无关', () => {
    expect(contrastRatio('#165DFF', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', '#165DFF'), 10)
  })
})
