import { describe, expect, it } from 'vitest'
import { formatRegion, parseRegion, regionCoverage } from '@/lib/region'

/**
 * 期望值来自引擎侧 `_parse_region` 的既有约定（full / x,y,w,h / 非法按整屏），
 * 这里是同一套口径在前端的复刻，两边必须一致。
 */
describe('监控区域解析', () => {
  it('full、空、非法值都按整屏处理', () => {
    expect(parseRegion('full')).toEqual({ kind: 'full' })
    expect(parseRegion('FULL')).toEqual({ kind: 'full' })
    expect(parseRegion('')).toEqual({ kind: 'full' })
    expect(parseRegion('   ')).toEqual({ kind: 'full' })
    expect(parseRegion('abc')).toEqual({ kind: 'full' })
    expect(parseRegion('1,2,3')).toEqual({ kind: 'full' })
    expect(parseRegion('1,2,3,4,5')).toEqual({ kind: 'full' })
    expect(parseRegion(null)).toEqual({ kind: 'full' })
  })

  it('宽高非正或不是数字都算非法', () => {
    expect(parseRegion('1,2,0,4')).toEqual({ kind: 'full' })
    expect(parseRegion('1,2,3,-4')).toEqual({ kind: 'full' })
    expect(parseRegion('a,b,c,d')).toEqual({ kind: 'full' })
  })

  it('合法的 x,y,w,h 解析成矩形', () => {
    expect(parseRegion('10,20,300,400')).toEqual({ kind: 'rect', x: 10, y: 20, width: 300, height: 400 })
  })

  it('容忍空格与小数（小数回写时取整）', () => {
    expect(parseRegion(' 10 , 20 , 300 , 400 ')).toEqual({ kind: 'rect', x: 10, y: 20, width: 300, height: 400 })
    expect(formatRegion(parseRegion('10.6,20.2,300.4,400.5'))).toBe('11,20,300,401')
  })

  it('解析与回写互为逆运算', () => {
    for (const s of ['full', '0,0,100,200', '1920,0,800,600']) {
      expect(formatRegion(parseRegion(s))).toBe(s)
    }
  })

  it('面积摘要用于界面提示', () => {
    expect(regionCoverage({ kind: 'full' })).toBe('整屏')
    expect(regionCoverage({ kind: 'rect', x: 0, y: 0, width: 300, height: 400 })).toBe('300 × 400')
  })
})
