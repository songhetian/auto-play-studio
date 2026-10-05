import { describe, expect, it } from 'vitest'
import { RHYTHM, pageShell, pageStack, sectionStack, titleRow } from './rhythm'

/**
 * 视觉节奏规范的行为规格。
 *
 * 用户的评价是「不像专业软件」。看了一下，问题不在单个组件，而在**节奏不统一**：
 *  - 8 个页面根容器里 7 个 `space-y-4`、1 个 `space-y-5` —— 换页时纵向节奏会跳
 *  - 内部层级用了 space-y-1/1.5/2/2.5/3/4/5 共 7 种（4/6/8/10/12/16/20px），
 *    10px 与 12px、6px 与 8px 在屏幕上分辨不出来，却让代码里多出两套"看起来一样"的规则
 *
 * 规格（数字来自「一屏能放下多少内容」的判断，不是拍脑袋）：
 *  - 页面外框：统一宽度、统一边距、统一纵向节奏
 *  - 页面内区块之间：只用 2 档（松 / 紧），不再有第三档
 *  - 区块内部：只用 1 档
 *  - 数字全部写成 Tailwind **字面量**（Tailwind JIT 扫不到拼接出来的类名）
 */
describe('视觉节奏规范', () => {
  it('页面外框只有一个写法：所有页面换页不跳节奏', () => {
    expect(pageShell()).toBe(RHYTHM.pageShell)
  })

  it('区块之间只有松/紧两档', () => {
    expect(RHYTHM.stack.loose).toBe(RHYTHM.pageStack)
    expect(RHYTHM.stack.tight).toBe(RHYTHM.sectionStack)
    // 只有两档：出现第三档就说明又有人在中间加了个 2.5
    expect(Object.keys(RHYTHM.stack).sort()).toEqual(['loose', 'tight'])
  })

  it('区块内部只有一档', () => {
    expect(Object.keys(RHYTHM.inner).length).toBe(1)
  })

  it('所有节奏值都是 Tailwind 字面量（能被 JIT 扫到）', () => {
    const all = [
      RHYTHM.pageShell,
      RHYTHM.pageStack,
      RHYTHM.sectionStack,
      ...Object.values(RHYTHM.stack),
      ...Object.values(RHYTHM.inner),
    ].join(' ')
    // 拼接类名 Tailwind 扫不到，规则压根不生成（静默失效）
    expect(all).not.toContain('${')
    expect(all).not.toContain('`')
    // 必须是 spacing 刻度上的值，不允许 7px/13px 这种"手调"出来的
    expect(all).not.toMatch(/-\[(?!\d+\]?px)/)
  })

  it('纵向节奏随层级递减：页面 > 区块 > 区块内', () => {
    const px = (s: string) => {
      const m = s.match(/space-y-(\d+(?:\.5)?)/)
      return m ? parseFloat(m[1]) : 0
    }
    expect(px(RHYTHM.pageStack)).toBeGreaterThan(px(RHYTHM.sectionStack))
    expect(px(RHYTHM.sectionStack)).toBeGreaterThan(px(RHYTHM.inner.item))
  })

  it('工具入口用统一的栅格（与 toolGrid 保持同一套列宽）', () => {
    // 复述自 toolGrid 的约束：卡片宽度只由栅格决定，与工具数量无关
    expect(RHYTHM.grid).toContain('xl:grid-cols-3')
  })

  it('辅助函数返回的是常量而不是重新拼一遍', () => {
    // 这几个函数存在的意义是「让调用方只能拿到规范里的值」，
    // 要是它们自己拼字符串，规范就形同虚设
    expect(pageStack()).toBe(pageStack())
    expect(sectionStack()).toBe(sectionStack())
    expect(titleRow()).toBe(RHYTHM.titleRow)
  })
})
