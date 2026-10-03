import { describe, expect, it } from 'vitest'
import { NAV_GROUPS, activeNavItem, allNavItems, filterNav, toolSections } from '@/app/navModel'
import { TOOLS } from '@/app/moduleRegistry'

/** 分组与条目是产品定义好的信息架构，期望值直接来自这份约定 */
const groupIds = (groups: ReturnType<typeof filterNav>) => groups.map((g) => g.id)
const labels = (groups: ReturnType<typeof filterNav>) => groups.flatMap((g) => g.items.map((i) => i.label))

describe('导航信息架构', () => {
  it('分成工作台 / 执行类 / 数据类 / 提醒类 / 辅助操作类 / 资源 / 系统 七组', () => {
    expect(groupIds(NAV_GROUPS)).toEqual(['workbench', 'exec', 'data', 'alert', 'assist', 'resource', 'system'])
  })

  it('工具按「谁触发、产出什么」归组，不按产物格式', () => {
    const byGroup = Object.fromEntries(NAV_GROUPS.map((g) => [g.id, g.items.map((i) => i.tool)]))
    // 程序调度、动屏幕、回写状态
    expect(byGroup.exec).toEqual(['rpa'])
    // 程序调度、不碰屏幕、出 Excel
    expect(byGroup.data).toEqual(['logi', 'cmp'])
    // 外部事件触发、产出通知 —— monitor 是常驻盯屏的提醒器，不是批处理执行器
    expect(byGroup.alert).toEqual(['monitor'])
    // 人按快捷键触发、产出当前窗口里的结果
    expect(byGroup.assist).toEqual(['macro'])
  })

  it('十二个条目、路径唯一', () => {
    const items = allNavItems()
    expect(items).toHaveLength(12)
    expect(new Set(items.map((i) => i.path)).size).toBe(12)
  })

  it('资源组放的是「全局一份、不可多开」的东西，不是工具', () => {
    const resource = NAV_GROUPS.find((g) => g.id === 'resource')!
    expect(resource.items.map((i) => i.id)).toEqual(['assets', 'kb', 'excel'])
    // 工具型条目带 tool：实例数徽标是照 tool 查的，资源条目挂上会渲染成脏徽标
    expect(resource.items.every((i) => i.tool === undefined)).toBe(true)
  })
})

describe('注册表与导航的对账', () => {
  /*
   * 工具条目是从 `TOOLS` 派生的，所以「有没有漏」不能靠肉眼扫一遍。
   * 真正的失效方式是**静默消失**：`group` 写错一个字母（`'alerts'`），
   * 哪个分组都筛不到它，侧栏与总览页一起少一个工具，全程没有任何报错。
   */
  it('每个已登记的工具都出现在导航里，且恰好一次', () => {
    const inNav = NAV_GROUPS.flatMap((g) => g.items.filter((i) => i.tool).map((i) => i.tool!))

    expect([...inNav].sort()).toEqual(TOOLS.map((t) => t.id).sort())
    // 分组 id 重了（两个组都叫 exec）会让同一个工具出场两次 —— 集合相等挡不住这个
    expect(new Set(inNav).size).toBe(inNav.length)
  })
})

describe('总览页的工具分段', () => {
  /*
   * 分段曾经硬编码在 `DashboardPage` 里（`TOOLS.filter(t => t.id === 'rpa' || t.id === 'monitor')`），
   * 分组却写在导航里 —— 改一边另一边不动。现在两边都从这一处派生，不一致不可能发生。
   */
  it('分段的顺序与成员跟导航分组完全一致', () => {
    expect(toolSections().map((s) => [s.id, s.label, s.tools.map((t) => t.id)])).toEqual([
      ['exec', '执行类工具', ['rpa']],
      ['data', '数据类工具', ['logi', 'cmp']],
      ['alert', '提醒类', ['monitor']],
      ['assist', '辅助操作类', ['macro']],
    ])
  })

  it('每个分段带一句人话说明，说的是「谁触发、什么时候用」', () => {
    expect(toolSections().map((s) => s.hint)).toEqual([
      '驱动键鼠，按表逐行跑批',
      '围绕 Excel 的批处理，不碰屏幕',
      '盯着屏幕，命中就通知',
      '按一下快捷键，在当前窗口立刻干活',
    ])
  })

  it('分组可以先定义好，等它有工具了再出现（空分组不渲染）', () => {
    // 「辅助操作类」当初就是这么预留的：先写好定义，没工具时不出现在页面上
    const defined = [
      { id: 'exec', label: '执行类工具', hint: '驱动键鼠，按表逐行跑批' },
      { id: 'assist', label: '辅助操作类', hint: '按一下快捷键，在当前窗口立刻干活' },
    ] as const
    const onlyRpa = TOOLS.filter((t) => t.id === 'rpa')

    expect(toolSections(defined, onlyRpa).map((s) => s.id)).toEqual(['exec'])
  })
})

describe('导航搜索', () => {
  it('空查询原样返回，不丢分组', () => {
    expect(filterNav('')).toBe(NAV_GROUPS)
    expect(filterNav('   ')).toBe(NAV_GROUPS)
  })

  it('按条目名命中', () => {
    expect(labels(filterNav('物流'))).toEqual(['物流信息查询'])
    expect(groupIds(filterNav('物流'))).toEqual(['data'])
  })

  it('按别名命中：英文 id 也能搜到', () => {
    expect(labels(filterNav('rpa'))).toEqual(['自动化脚本助手'])
    expect(labels(filterNav('cmp'))).toEqual(['Excel 多表对比'])
  })

  it('按别名命中：用户口语也能搜到', () => {
    expect(labels(filterNav('截图'))).toEqual(['图像素材库'])
    expect(labels(filterNav('深色'))).toEqual(['设置'])
    expect(labels(filterNav('快递'))).toEqual(['物流信息查询'])
    // 知识库是「按内容找文件」这件事本身，用户不会先想到「知识库」这个词
    expect(labels(filterNav('拼音'))).toEqual(['知识库'])
    expect(labels(filterNav('全文检索'))).toEqual(['知识库'])
    expect(labels(filterNav('话术'))).toEqual(['知识库'])
    // 表格有问题时，用户嘴里说的是「去重」「空行」「表头」，不会说「Excel 体检」
    expect(labels(filterNav('去重'))).toEqual(['Excel 体检与整理'])
    expect(labels(filterNav('空行'))).toEqual(['Excel 体检与整理'])
    expect(labels(filterNav('台账'))).toEqual(['Excel 体检与整理'])
  })

  it('按分组名命中时带出该组全部条目', () => {
    expect(labels(filterNav('数据类'))).toEqual(['物流信息查询', 'Excel 多表对比'])
    expect(labels(filterNav('执行类'))).toEqual(['自动化脚本助手'])
    expect(labels(filterNav('提醒类'))).toEqual(['桌面图片监控'])
    expect(labels(filterNav('辅助操作类'))).toEqual(['按键精灵'])
  })

  it('工具的搜索别名跟着注册表走，挪组不会丢', () => {
    // 用户嘴里的「监控」「告警」指的是常驻盯屏这件事，不会去输「桌面图片监控」
    expect(labels(filterNav('监控'))).toEqual(['桌面图片监控'])
    expect(labels(filterNav('告警'))).toEqual(['桌面图片监控'])
    // 别名要挑「只有它能命中」的：「一键」会串到 Excel 页的说明「一键整理出新文件」
    expect(labels(filterNav('连按'))).toEqual(['按键精灵'])
    expect(labels(filterNav('复制粘贴'))).toEqual(['按键精灵'])
  })

  it('多词是 AND：范围越收越窄', () => {
    expect(labels(filterNav('excel 对比'))).toEqual(['Excel 多表对比'])
    expect(labels(filterNav('excel 监控'))).toEqual([])
  })

  it('忽略大小写与两侧空格', () => {
    expect(labels(filterNav('  LOGI  '))).toEqual(['物流信息查询'])
    expect(labels(filterNav('  RPA  '))).toEqual(['自动化脚本助手'])
  })

  it('说明文字命中也算命中：搜 excel 会带出所有与 Excel 相关的工具', () => {
    expect(labels(filterNav('excel'))).toEqual([
      '自动化脚本助手',
      '物流信息查询',
      'Excel 多表对比',
      'Excel 体检与整理',
    ])
  })

  it('无命中返回空数组，不返回空分组', () => {
    expect(filterNav('zzz')).toEqual([])
  })
})

describe('当前选中项', () => {
  it('精确路径命中', () => {
    expect(activeNavItem('/assets')?.id).toBe('assets')
    expect(activeNavItem('/')?.id).toBe('dashboard')
  })

  it('二级路径退化成最长前缀匹配', () => {
    expect(activeNavItem('/tools/rpa')?.id).toBe('tool-rpa')
  })

  it('实例窗口不在导航里，返回 undefined', () => {
    expect(activeNavItem('/instance/M1/config')).toBeUndefined()
  })
})
