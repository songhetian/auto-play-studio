import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 话术速查面板（坐席助手）的全局偏好。
 *
 * 与实例配置无关、与外观无关，是「面板怎么帮我」这一类开关的落点。
 * 沿用项目约定：zustand + persist 落 localStorage，跨会话记住、即时生效。
 */
interface AttendantState {
  /**
   * 插入带 `{客户名}` / `{订单号}` 的话术时，自动从选区推断并替掉变量。
   * 默认开：坐席框住客户消息再插入话术，名字/单号直接带上最顺手；
   * 关掉则一律保留占位符，由坐席手填（更保守，适合不想被误填的场景）。
   */
  autoFillVars: boolean
  setAutoFillVars: (v: boolean) => void
}

export const useAttendantStore = create<AttendantState>()(
  persist(
    (set) => ({
      autoFillVars: true,
      setAutoFillVars: (v) => set({ autoFillVars: v }),
    }),
    { name: 'autoplay.attendant' },
  ),
)
