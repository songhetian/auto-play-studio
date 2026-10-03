import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface NavState {
  /** 折叠的分组 id → true；未出现的分组默认展开 */
  collapsed: Record<string, boolean>
  toggle: (groupId: string) => void
  setCollapsed: (groupId: string, value: boolean) => void
  /** 收成只留图标的一条窄栏；小屏或专注执行时用 */
  rail: boolean
  toggleRail: () => void
}

/** 左侧导航的整理状态（分组展开 + 是否收窄），跨会话记住用户习惯 */
export const useNavStore = create<NavState>()(
  persist(
    (set) => ({
      collapsed: {},
      toggle: (groupId) => set((s) => ({ collapsed: { ...s.collapsed, [groupId]: !s.collapsed[groupId] } })),
      setCollapsed: (groupId, value) => set((s) => ({ collapsed: { ...s.collapsed, [groupId]: value } })),
      rail: false,
      toggleRail: () => set((s) => ({ rail: !s.rail })),
    }),
    { name: 'autoplay.nav' },
  ),
)
