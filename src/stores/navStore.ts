import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface NavState {
  /** 折叠的分组 id → true；未出现的分组默认展开 */
  collapsed: Record<string, boolean>
  toggle: (groupId: string) => void
  setCollapsed: (groupId: string, value: boolean) => void
  /** 收成只留图标的一条窄栏；小屏或专注执行时用（默认 false = 显示工具名） */
  rail: boolean
  toggleRail: () => void
  setRail: (value: boolean) => void
}

/**
 * 左侧导航的整理状态（分组展开 + 是否收窄），跨会话记住用户习惯。
 *
 * `version: 1` + `migrate`：0.0.x 时代曾经默认收窄过一段时间，
 * 那些老用户 localStorage 里还留着 rail=true，升级后会「只剩图标、看不到工具名」。
 * migrate 里强制回到展开态（rail:false），之后才正常记住用户自己的选择。
 */
export const useNavStore = create<NavState>()(
  persist(
    (set) => ({
      collapsed: {},
      toggle: (groupId) => set((s) => ({ collapsed: { ...s.collapsed, [groupId]: !s.collapsed[groupId] } })),
      setCollapsed: (groupId, value) => set((s) => ({ collapsed: { ...s.collapsed, [groupId]: value } })),
      rail: false,
      toggleRail: () => set((s) => ({ rail: !s.rail })),
      setRail: (value) => set({ rail: value }),
    }),
    {
      name: 'autoplay.nav',
      version: 1,
      migrate: (persisted) => {
        const s = (persisted ?? {}) as Partial<NavState>
        // 强制展开，保证侧边栏一定能看到工具名；分组折叠偏好保留
        return { ...s, rail: false } as NavState
      },
    },
  ),
)
