import { describe, expect, it } from 'vitest'
import { TOOLS, toolById, toolGroups } from './toolboxModel'

describe('工具清单', () => {
  it('七个工具都有 id / 名称 / 图标 / 简介', () => {
    // 少一个字段，侧栏就会渲染出一个没有名字或没有图标的条目
    for (const t of TOOLS) {
      expect(t.id).toBeTruthy()
      expect(t.name).toBeTruthy()
      expect(t.icon).toBeTruthy()
      expect(t.desc).toBeTruthy()
    }
  })

  it('工具 id 不重复', () => {
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(TOOLS.length)
  })

  it('toolById 能查到，也能对未知 id 返回 undefined', () => {
    expect(toolById('merge')?.name).toBe('合并 / 补全')
    expect(toolById('nope')).toBeUndefined()
  })

  it('分组把七个工具都归到某组_不漏也不重', () => {
    const grouped = toolGroups().flatMap((g) => g.items)
    expect(grouped.map((t) => t.id).sort()).toEqual(TOOLS.map((t) => t.id).sort())
  })

  it('高优先级三个：合并、生成新表、去重', () => {
    // 这三个覆盖客服 80% 的表格活，做不好其余都是锦上添花
    expect(TOOLS.filter((t) => t.primary).map((t) => t.id).sort()).toEqual(['dedupe', 'generate', 'merge'])
  })
})
