import { describe, expect, it } from 'vitest'
import { targetFromRegion, targetLabel } from './fillTarget'

/**
 * 框选结果 → 存给引擎的目标。
 *
 * 这几条守卫都是「宁可不存，也不存一个会乱点的目标」：
 * 引擎那边 `Target` 也会挡，但界面得先自己挡住 —— 否则用户点完框选、
 * 以为配好了，实际存进去的是一个永远填不成的东西。
 */
describe('targetFromRegion', () => {
  const region = { x: 100, y: 200, width: 300, height: 40 }

  it('窗口关键字 + 框选矩形 → 引擎要的那个目标', () => {
    expect(targetFromRegion('千牛', region)).toEqual({
      window: '千牛',
      x: 100,
      y: 200,
      width: 300,
      height: 40,
    })
  })

  it('关键字两边的空格去掉_引擎是按「标题包含」匹配的', () => {
    expect(targetFromRegion('  千牛工作台  ', region)?.window).toBe('千牛工作台')
  })

  it('没填窗口关键字就不存_空字符串会匹配到随便哪个窗口', () => {
    expect(targetFromRegion('', region)).toBeNull()
    expect(targetFromRegion('   ', region)).toBeNull()
  })

  it('取消框选（没框到）不存_不能拿上一次的坐标顶上', () => {
    expect(targetFromRegion('千牛', null)).toBeNull()
    expect(targetFromRegion('千牛', undefined)).toBeNull()
  })

  it('零面积的矩形不存_它没有中心可点', () => {
    expect(targetFromRegion('千牛', { ...region, width: 0 })).toBeNull()
    expect(targetFromRegion('千牛', { ...region, height: 0 })).toBeNull()
  })

  it('小数坐标取整_引擎那边是整数像素', () => {
    expect(targetFromRegion('千牛', { x: 10.6, y: 20.4, width: 300.2, height: 40.9 })).toEqual({
      window: '千牛',
      x: 11,
      y: 20,
      width: 300,
      height: 41,
    })
  })
})

describe('targetLabel', () => {
  it('没配过时明说没配', () => {
    expect(targetLabel(null)).toContain('还没')
  })

  it('配过时带上窗口与矩形_便于一眼确认没框错', () => {
    const label = targetLabel({ window: '千牛工作台', x: 100, y: 200, width: 300, height: 40 })

    expect(label).toContain('千牛工作台')
    expect(label).toContain('300')
    expect(label).toContain('40')
  })
})
