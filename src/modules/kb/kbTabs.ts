import type { IconName } from '@/components/icon'

/** 知识库里的内容分区：每一块明确归属一个 Tab，不允许"到处都是" */
export type KbSection =
  | 'indexing'
  | 'stats'
  | 'folders'
  | 'searchBox'
  | 'results'
  | 'history'

export type KbTabId = 'manage' | 'search'

export interface KbTab {
  id: KbTabId
  label: string
  /** 顶栏副标题：说清这个 Tab 到底管什么 */
  desc: string
  icon: IconName
}

export const KB_TABS: KbTab[] = [
  {
    id: 'manage',
    label: '资料管理',
    desc: '登记要查阅的文件夹、看索引进度、维护资料库',
    icon: 'folder',
  },
  {
    id: 'search',
    label: '搜索浏览',
    desc: '按内容搜索已登记的资料，查看命中片段与历史',
    icon: 'search',
  },
]

/** 区块 → Tab 的归属表。写死在这里而不是散在 JSX 里，才有一处可测的规则 */
const SECTION_TAB: Record<KbSection, KbTabId> = {
  indexing: 'manage',
  stats: 'manage',
  folders: 'manage',
  searchBox: 'search',
  results: 'search',
  history: 'search',
}

export const tabOf = (section: KbSection): KbTab =>
  KB_TABS.find((t) => t.id === SECTION_TAB[section]) ?? KB_TABS[0]

/** 按 Tab id 取 Tab 定义（渲染顶栏副标题用） */
export const tabById = (id: KbTabId): KbTab => KB_TABS.find((t) => t.id === id) ?? KB_TABS[0]

export const visibleTabs = (): KbTab[] => KB_TABS
