import type { ToolType } from '@/schemas/instance'
import { TOOLS, type ToolGroupId, type ToolModule } from '@/app/moduleRegistry'
import type { IconName } from '@/components/icon'

/**
 * 左侧导航的信息架构（单一真源）。
 *
 * 一层是「功能类型」分组，二层是具体功能项 —— 这就是左侧导航里的二级菜单。
 * 新增功能只在这里加一条，导航、搜索、面包屑会自动带上它。
 */

export interface NavItem {
  id: string
  label: string
  /** 一句话说明，搜索命中与悬停提示都用它 */
  desc: string
  path: string
  /** 语义图标名，由 Icon 组件映射到具体形状；换图标库不影响这里 */
  icon: IconName
  /** 工具型条目：带品牌色，并显示该工具的实例数徽标 */
  tool?: ToolType
  color?: string
  /** 搜索别名：英文 id、同义词、用户可能输入的叫法 */
  keywords: string[]
}

export interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

/**
 * 工具分组的**顺序与标题**。
 *
 * 工具自身「是什么」（名字 / 说明 / 图标 / 颜色 / 搜索别名 / 归哪一组）在 `moduleRegistry`；
 * 这里只管它在信息架构里的位置。分工是有意的，但**同一件事不写两遍** ——
 * 曾经名字与说明两处各存一份，`rpa` 的说明在侧栏和工具卡上已经显示成两句不同的话。
 */
/** 分组的定义：位置（顺序）+ 标题 + 一句话说明。成员由工具的 `group` 决定，不在这里列 */
export type ToolGroupDef = { id: ToolGroupId; label: string; hint: string }

const TOOL_GROUPS: ToolGroupDef[] = [
  { id: 'exec', label: '执行类工具', hint: '驱动键鼠，按表逐行跑批' },
  { id: 'data', label: '数据类工具', hint: '围绕 Excel 的批处理，不碰屏幕' },
  { id: 'alert', label: '提醒类', hint: '盯着屏幕，命中就通知' },
  { id: 'assist', label: '辅助操作类', hint: '按一下快捷键，在当前窗口立刻干活' },
]

/** 工具条目由注册表派生 —— 元数据只有一个来源，就不存在两边各自漂移 */
const toToolItem = (t: ToolModule): NavItem => ({
  id: `tool-${t.id}`,
  label: t.name,
  desc: t.desc,
  path: `/tools/${t.id}`,
  icon: t.icon,
  tool: t.id,
  color: t.color,
  keywords: t.keywords,
})

const toolGroupNodes = (): NavGroup[] =>
  TOOL_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    items: TOOLS.filter((t) => t.group === g.id).map(toToolItem),
  }))

/** 工作台：跨工具的全局视图 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'workbench',
    label: '工作台',
    items: [
      {
        id: 'dashboard',
        label: '总览',
        desc: '运行概况、异常提醒与快捷新建',
        path: '/',
        icon: 'dashboard',
        keywords: ['dashboard', 'overview', '首页', '概览', '总控', '仪表盘', '运行中'],
      },
      {
        id: 'instances',
        label: '实例管理',
        desc: '全部实例的检索、配置与启停',
        path: '/instances',
        icon: 'instances',
        keywords: ['instances', '列表', '实例', '任务', '多开', '管理'],
      },
    ],
  },
  ...toolGroupNodes(),
  {
    id: 'resource',
    label: '资源',
    items: [
      {
        id: 'assets',
        label: '图像素材库',
        desc: '图像指令的唯一素材源，支持框选截图入库',
        path: '/assets',
        icon: 'assets',
        keywords: ['assets', '素材', '图片', '图库', '截图', '截屏', '模板图'],
      },
      {
        id: 'kb',
        label: '知识库',
        desc: '登记资料文件夹，按正文或拼音搜到具体文件',
        path: '/kb',
        icon: 'database',
        keywords: [
          'kb',
          'knowledge',
          '知识库',
          '内容搜索',
          '全文检索',
          '搜内容',
          '资料',
          '文档检索',
          '话术',
          '拼音',
        ],
      },
      {
        id: 'excel',
        label: 'Excel 体检与整理',
        desc: '跑之前先看一遍表，一键整理出新文件并留下改动台账',
        path: '/excel',
        icon: 'sheet',
        keywords: [
          'excel',
          'xlsx',
          '表格',
          '体检',
          '预检',
          '整理',
          '清洗',
          '去重',
          '重复行',
          '重复主键',
          '空行',
          '空主键',
          '表头',
          '列名',
          '台账',
        ],
      },
    ],
  },
  {
    id: 'system',
    label: '系统',
    items: [
      {
        id: 'settings',
        label: '设置',
        desc: '外观主题、引擎连通性与数据目录',
        path: '/settings',
        icon: 'settings',
        keywords: ['settings', '偏好', '设置', '主题', '外观', '暗色', '深色', '浅色', 'dark', 'theme', '引擎', '数据目录'],
      },
    ],
  },
]

/**
 * 总览页的工具分段。
 *
 * 这里只是把「分组定义」再喂一遍 —— 分段与导航的分组**同源同序**，
 * 不一致不可能发生。曾经分段硬编码在 `DashboardPage` 里，分组改在导航里，
 * 改一边另一边不动。
 *
 * `groups` / `tools` 可注入是为了能测「分组先定义好、还没工具时不该出现」；
 * 平时按默认值调用。
 */
export interface ToolSection {
  id: ToolGroupId
  label: string
  /** 这一组是干什么的，总览页段落标题下显示 */
  hint: string
  tools: ToolModule[]
}

export function toolSections(
  groups: ReadonlyArray<ToolGroupDef> = TOOL_GROUPS,
  tools: readonly ToolModule[] = TOOLS,
): ToolSection[] {
  return groups
    .map((g) => ({ id: g.id, label: g.label, hint: g.hint, tools: tools.filter((t) => t.group === g.id) }))
    // 空分组不渲染：分组定义可以先写好，等它有第一个工具再出现在页面上
    .filter((s) => s.tools.length > 0)
}

/** 按功能类型分组的导航，全部条目扁平化后的顺序 */
export function allNavItems(groups: NavGroup[] = NAV_GROUPS): NavItem[] {
  return groups.flatMap((g) => g.items)
}

/**
 * 导航搜索：空查询原样返回；否则只留命中的条目，丢掉空分组。
 *
 * 命中规则（任一即可）：
 *  - 条目名包含查询
 *  - 条目说明包含查询
 *  - 任一走 keywords 的别名包含查询
 *  - 分组名本身命中 → 该分组全部条目保留（输入「数据类」能带出物流与对比）
 *
 * 分词：查询按空格切开，全部词都要命中（AND），这样「excel 对比」也能收敛到位。
 */
export function filterNav(query: string, groups: NavGroup[] = NAV_GROUPS): NavGroup[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return groups

  const hitText = (it: NavItem, term: string) =>
    it.label.toLowerCase().includes(term) ||
    it.desc.toLowerCase().includes(term) ||
    it.keywords.some((k) => k.toLowerCase().includes(term))

  return groups
    .map((g) => {
      const groupHit = terms.every((t) => g.label.toLowerCase().includes(t))
      const items = groupHit ? g.items : g.items.filter((it) => terms.every((t) => hitText(it, t)))
      return { ...g, items }
    })
    .filter((g) => g.items.length > 0)
}

/** 当前路径对应的导航条目（用于选中态与面包屑）；找不到返回 undefined */
export function activeNavItem(pathname: string, groups: NavGroup[] = NAV_GROUPS): NavItem | undefined {
  const items = allNavItems(groups)
  // 先精确匹配，再退化成「最长前缀匹配」，这样 /tools/rpa?x=1 之类也能选中
  return (
    items.find((it) => it.path === pathname) ??
    items
      .filter((it) => it.path !== '/' && pathname.startsWith(it.path))
      .sort((a, b) => b.path.length - a.path.length)[0]
  )
}
