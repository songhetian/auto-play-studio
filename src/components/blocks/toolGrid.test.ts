import { describe, expect, it } from 'vitest'
import { NAV_GROUPS, toolSections } from '@/app/navModel'
import { TOOL_GRID, UTILITY_COLUMNS, UTILITY_GRID, padToColumns, toolGridClass } from './toolGrid'

/**
 * 工具箱栅格的规格。
 *
 * 原来的问题：每个分组各自写 `grid sm:grid-cols-2`，于是「执行类工具」1 张卡只占半行、
 * 「数据类工具」2 张卡铺满整行，同一页里卡片宽度各不相同，看起来像没对齐的拼图。
 *
 * 规格：
 *  - 整页所有工具卡（含「资源与系统」入口）用**同一套**列数，不按分组数量自适应
 *  - 任何一张卡在该栅格里占据的列数与宽度都必须相同
 *  - 分组只有 1 个工具时，它依然占标准列宽，而不是撑满整行
 */
describe('工具箱栅格', () => {
  it('所有工具分组与资源入口共用同一套栅格类名', () => {
    const sections = toolSections()
    expect(sections.length).toBeGreaterThan(1)

    // 规格值唯一：所有分组拿到的是同一个 class 串
    const classes = sections.map((s) => toolGridClass(s.id))
    expect(new Set(classes).size).toBe(1)
  })

  it('栅格至少两列，单个工具不会撑满整行', () => {
    expect(TOOL_GRID.minColumns).toBeGreaterThanOrEqual(2)
  })

  it('列宽定义唯一（所有卡等宽），不随分组里工具数量变化', () => {
    const one = toolSections().find((s) => s.tools.length === 1)
    const two = toolSections().find((s) => s.tools.length >= 2)

    // 有的分组 1 个工具、有的 2 个，但栅格定义必须一致
    expect(one).toBeTruthy()
    expect(two).toBeTruthy()
    expect(toolGridClass(one!.id)).toBe(toolGridClass(two!.id))
  })

  it('每个分组的工具都参与同一个栅格（不留孤儿宽度）', () => {
    for (const s of toolSections()) {
      // 工具数量不该影响列宽选择，否则又回到「1 张半行、2 张满行」
      expect(s.tools.length).toBeGreaterThan(0)
    }
  })

  it('列类名必须是字面量，不能靠模板字符串拼（Tailwind JIT 扫不到）', () => {
    const cls = toolGridClass()
    // Tailwind 只为源码里出现的完整字面量生成规则；
    // 写成 `xl:grid-cols-${n}` 的话规则压根不生成，页面仍是 2 列 —— 静默失效。
    expect(cls).toContain('sm:grid-cols-2')
    expect(cls).toContain('xl:grid-cols-3')
    // 拼接痕迹会带 ${ 或反引号
    expect(cls).not.toContain('${')
    expect(cls).not.toContain('`')
  })

  it('资源入口用 3 列_6 个入口两行放齐，不留孤零零的第二行', () => {
    // 列数必须与入口数对齐：列数不是入口数的整数倍时，第二行会孤零零一张卡，
    // 而且那张卡和上面不等高（用户看到的「框大小不一致」就是这么来的）。
    // 类名必须写字面量：Tailwind JIT 扫源码，拼出来的规则压根不生成。
    expect(UTILITY_GRID).toContain('lg:grid-cols-3')
  })

  it('资源入口数量是列数的整数倍_不产生孤行', () => {
    // 从 UTILITY_GRID 里读出列数，而不是写死 5：加工具后列数要跟着改，
    // 写死数字会让人只顾着加条目、忘了调栅格
    const cols = Number(/lg:grid-cols-(\d+)/.exec(UTILITY_GRID)?.[1] ?? 0)
    expect(cols).toBeGreaterThan(0)
    expect(utilityCount() % cols).toBe(0)
  })

  it('补位占位不可见但能撑住网格高度', () => {
    const five = padToColumns([1, 2, 3, 4, 5], 4)
    expect(five).toHaveLength(8)
    // 占位是 null，渲染时跳过
    expect(five.filter((x) => x === null)).toHaveLength(3)

    const four = padToColumns([1, 2, 3, 4], 4)
    expect(four).toHaveLength(4)
    expect(four.every((x) => x !== null)).toBe(true)
  })

  it('空列表不补位_不该平白多出 4 个空格子', () => {
    expect(padToColumns([], 4)).toEqual([])
  })

  it('UTILITY_COLUMNS 与 UTILITY_GRID 的列数一致_补位用对的列数', () => {
    // 首页曾经写死 padToColumns(items, 5)，而栅格是 3 列 → 多补出两整行空白。
    // 列数抽成常量并在这里钉死与 class 的一致性。
    const cols = Number(/lg:grid-cols-(\d+)/.exec(UTILITY_GRID)?.[1] ?? 0)
    expect(UTILITY_COLUMNS).toBe(cols)

    const items = NAV_GROUPS.filter((g) => g.id === 'resource' || g.id === 'system').flatMap((g) => g.items)
    expect(items.length % UTILITY_COLUMNS).toBe(0)
    // 入口数是列数整数倍 → 不该再补出空占位
    expect(padToColumns(items, UTILITY_COLUMNS)).toHaveLength(items.length)
  })
})

/** 资源与系统入口的条目数（与 navModel 保持一致，这里取真实来源） */
function utilityCount(): number {
  return NAV_GROUPS.filter((g) => g.id === 'resource' || g.id === 'system').flatMap((g) => g.items).length
}
