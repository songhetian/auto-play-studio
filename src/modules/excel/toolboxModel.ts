import type { IconName } from '@/components/icon'

/**
 * Excel 工具箱的工具清单（单一真源）。
 *
 * 侧栏渲染、说明文案都从这里读 —— 加一个工具只改这一处，
 * 不会出现"侧栏有但页面没有"或反过来的分叉。
 *
 * 分组沿用原型里的两类：整理（改表的内容）与转换（改表的格式）。
 */
export type ToolId =
  | 'merge'
  | 'generate'
  | 'dedupe'
  | 'convert'
  | 'split'
  | 'problem'
  | 'filter'

export interface ToolboxTool {
  id: ToolId
  name: string
  /** 一句话说清这个工具干什么，鼠标悬停在侧栏上就能看到 */
  desc: string
  icon: IconName
  group: 'tidy' | 'convert'
  /**
   * 高频工具：排在侧栏前面并加实心标记。
   * 这三个（合并 / 生成新表 / 去重）覆盖客服 80% 的表格活。
   */
  primary?: boolean
  /** 这个工具要几个输入表：1 = 只需源表，2 = 主表 + 来源表 */
  inputs?: 1 | 2
}

export const TOOLS: ToolboxTool[] = [
  {
    id: 'merge',
    name: '合并 / 补全',
    desc: '按若干列对齐两张表，把来源表的列补到主表上；匹配列可加到任意多列',
    icon: 'link',
    group: 'tidy',
    primary: true,
    inputs: 2,
  },
  {
    id: 'generate',
    name: '生成新表',
    desc: '勾选要保留的列，按勾选顺序生成一张新表',
    icon: 'sheet',
    group: 'tidy',
    primary: true,
  },
  {
    id: 'dedupe',
    name: '按业务键去重',
    desc: '按你指定的业务键去重，保留第一条；不指定键则按整行去重',
    icon: 'filter',
    group: 'tidy',
    primary: true,
  },
  {
    id: 'convert',
    name: '格式互转',
    desc: 'xlsx 与 csv 互转，csv 存为 utf-8-bom，Excel 打开不乱码',
    icon: 'refresh',
    group: 'convert',
  },
  {
    id: 'split',
    name: '按列拆分',
    desc: '按某列的每个值拆成独立文件，空值归到「空」一组不丢行',
    icon: 'copy',
    group: 'convert',
  },
  {
    id: 'problem',
    name: '问题行导出',
    desc: '挑出空主键与主键重复的行，带 Excel 行号方便回原表改',
    icon: 'warning',
    group: 'tidy',
  },
  {
    id: 'filter',
    name: '条件筛选导出',
    desc: '按某列等值筛出子集，另存为新表',
    icon: 'search',
    group: 'tidy',
  },
]

const GROUPS = [
  { id: 'tidy', label: '整理' },
  { id: 'convert', label: '转换' },
] as const

export function toolById(id: string): ToolboxTool | undefined {
  return TOOLS.find((t) => t.id === id)
}

/** 按分组返回工具，组内高优先级的排前面 */
export function toolGroups() {
  return GROUPS.map((g) => ({
    ...g,
    items: TOOLS.filter((t) => t.group === g.id).sort((a, b) => Number(b.primary ?? false) - Number(a.primary ?? false)),
  }))
}
