import { describe, expect, it } from 'vitest'
import { NAV_GROUPS, activeNavItem, allNavItems, filterNav, toolSections } from '@/app/navModel'
import { TOOLS } from '@/app/moduleRegistry'

/** 分组与条目是产品定义好的信息架构，期望值直接来自这份约定 */
const groupIds = (groups: ReturnType<typeof filterNav>) => groups.map((g) => g.id)
const labels = (groups: ReturnType<typeof filterNav>) => groups.flatMap((g) => g.items.map((i) => i.label))

describe('导航信息架构', () => {
  it('分成工作台 / 执行类 / 数据类 / 提醒类 / 辅助操作类 / 资源 / 客服工具 / 系统 八组', () => {
    expect(groupIds(NAV_GROUPS)).toEqual([
      'workbench',
      'exec',
      'data',
      'alert',
      'assist',
      'resource',
      'service',
      'system',
    ])
  })

  it('工具按「谁触发、产出什么」归组，不按产物格式', () => {
    const byGroup = Object.fromEntries(NAV_GROUPS.map((g) => [g.id, g.items.map((i) => i.tool)]))
    // 程序调度、动屏幕、回写状态
    expect(byGroup.exec).toEqual(['rpa'])
    // 程序调度、不碰屏幕、出 Excel
    expect(byGroup.data).toEqual(['logi', 'cmp'])
    // 外部事件触发、产出通知 —— monitor（盯屏找图）与 guard（读输入框找词）
    // 都是常驻提醒器，不是批处理执行器
    expect(byGroup.alert).toEqual(['monitor', 'guard'])
    // 人按快捷键触发、产出当前窗口里的结果
    expect(byGroup.assist).toEqual(['macro'])
  })

  it('条目数与路径唯一', () => {
    // 不写死数字：加功能时这条测试应该只校验"路径不重复"这个不变量，
    // 数量变化是预期行为，不该每次都来改这里
    const items = allNavItems()
    expect(items.length).toBeGreaterThan(0)
    expect(new Set(items.map((i) => i.path)).size).toBe(items.length)
  })

  it('资源组放的是「全局一份、不可多开」的东西，不是工具', () => {
    const resource = NAV_GROUPS.find((g) => g.id === 'resource')!
    // 词库与素材库、知识库同属「全局一份、不可多开」：合规规则对公司是统一的，
    // 复制到每个实例里改出分叉才是隐患
    expect(resource.items.map((i) => i.id)).toEqual(['assets', 'sensitiveWords', 'kb', 'excelToolbox', 'excel'])
    // 工具型条目带 tool：实例数徽标是照 tool 查的，资源条目挂上会渲染成脏徽标
    expect(resource.items.every((i) => i.tool === undefined)).toBe(true)
  })

  it('客服工具组独立于资源组：它是日常要用的功能，不是「配置类资产」', () => {
    const service = NAV_GROUPS.find((g) => g.id === 'service')!
    expect(service.items.map((i) => i.id)).toEqual(['flowGuide', 'reminders', 'phrases'])
    // 同样不该带 tool（话术不是可多开的实例）
    expect(service.items.every((i) => i.tool === undefined)).toBe(true)
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
      ['alert', '提醒类', ['monitor', 'guard']],
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
    // 「话术」现在指向独立的话术库，不再是知识库的别名（两者已拆成不同功能）
    expect(labels(filterNav('话术'))).toEqual(['话术库'])
    expect(labels(filterNav('快捷回复'))).toEqual(['话术库'])
    // 表格有问题时，用户嘴里说的是「去重」「空行」「表头」，不会说「Excel 体检」——
    // 「去重」两个 Excel 功能都有，工具箱与体检都该被带出来
    expect(labels(filterNav('去重'))).toEqual(['Excel 工具箱', 'Excel 体检与整理'])
    expect(labels(filterNav('空行'))).toEqual(['Excel 体检与整理'])
    expect(labels(filterNav('台账'))).toEqual(['Excel 体检与整理'])
  })

  it('按分组名命中时带出该组全部条目', () => {
    expect(labels(filterNav('数据类'))).toEqual(['物流信息查询', 'Excel 多表对比'])
    expect(labels(filterNav('执行类'))).toEqual(['自动化脚本助手'])
    expect(labels(filterNav('提醒类'))).toEqual(['桌面图片监控', '敏感词监控'])
    expect(labels(filterNav('辅助操作类'))).toEqual(['按键精灵'])
  })

  it('工具的搜索别名跟着注册表走，挪组不会丢', () => {
    // 用户嘴里的「监控」指的是常驻盯屏这件事，不会去输「桌面图片监控」。
    // 现在带出两个监控工具是**对的**：图片监控盯画面、敏感词监控盯输入框，
    // 用户搜「监控」本就不该只看到其中一个。
    expect(labels(filterNav('监控'))).toEqual(['桌面图片监控', '敏感词监控', '敏感词库'])
    // 「告警」仍是图片监控独有的说法（词库与敏感词监控都不自称告警工具）
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
      'Excel 工具箱',
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
