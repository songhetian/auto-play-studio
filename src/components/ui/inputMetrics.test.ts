import { describe, expect, it } from 'vitest'
import { inputPadding, inputTypo } from './inputMetrics'

/**
 * 输入框留白规范。
 *
 * 背景：裸 `<input>` 在 Tailwind 预检下**没有任何内边距**，文字直接贴左边框。
 * 而带 prefix 的分支有 `px-2.5` —— 于是同一个应用里两种输入框内边距不一致，
 * 看起来"有的框很挤、有的正常"。这里把留白抽成单一真源。
 */
describe('输入框留白与字号规范', () => {
  it('三档尺寸都要有横向内边距_文字不能贴左边框', () => {
    for (const size of ['sm', 'default', 'lg'] as const) {
      expect(inputPadding(size), size).toMatch(/px-/)
    }
  })

  it('小号框的留白要比大号更紧_但不能没有', () => {
    const pxOf = (cls: string) => Number(/px-([\d.]+)/.exec(cls)?.[1] ?? 0)
    expect(pxOf(inputPadding('lg'))).toBeGreaterThan(pxOf(inputPadding('sm')))
  })

  it('默认尺寸横向内边距定为 px-3_不再局促且三档严格递增', () => {
    const pxOf = (cls: string) => Number(/px-([\d.]+)/.exec(cls)?.[1] ?? 0)
    // 用户反馈"输入框过于靠左、空间局促" → 默认档定为 px-3，与 Textarea 对齐
    expect(inputPadding('default')).toBe('px-3')
    expect(pxOf(inputPadding('sm'))).toBeLessThan(pxOf(inputPadding('default')))
    expect(pxOf(inputPadding('default'))).toBeLessThan(pxOf(inputPadding('lg')))
  })

  it('三档字号递增_小号小于大号', () => {
    const order = ['2xs', 'xs', 'sm', 'base', 'md', 'lg', 'xl']
    const sizeOf = (cls: string) => order.indexOf(/text-([a-z0-9]+)/.exec(cls)?.[1] ?? '')
    expect(sizeOf(inputTypo('sm'))).toBeLessThan(sizeOf(inputTypo('lg')))
  })

  it('类名必须是字面量_不能靠拼接（Tailwind JIT 扫不到）', () => {
    for (const size of ['sm', 'default', 'lg'] as const) {
      expect(inputPadding(size)).not.toContain('${')
      expect(inputPadding(size)).not.toContain('`')
    }
  })
})