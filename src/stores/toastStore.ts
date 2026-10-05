import { create } from 'zustand'

/** 提醒的语气：决定配色与图标，文案本身由调用方给（都写成人话）。 */
export type ToastTone = 'success' | 'error' | 'info' | 'warning'

export interface ToastItem {
  id: number
  tone: ToastTone
  message: string
}

/** 同时最多显示几条。超出丢掉最旧的，免得刷屏把页面盖住。 */
export const MAX_TOASTS = 4
/** 默认停留时长（毫秒）。传 0 表示常驻，得手动关。 */
export const TOAST_DURATION = 3500

interface ToastState {
  items: ToastItem[]
  push: (message: string, tone?: ToastTone, duration?: number) => number
  dismiss: (id: number) => void
  clear: () => void
}

/** 自增 id：同一条消息连发两次也要能各自关闭 */
let seq = 0

/**
 * 全局提醒队列。
 *
 * 为什么是 store 而不是组件内 state：很多地方是「事件回调 / 异步结果」里要提示，
 * 拿不到组件上下文；放全局后任意位置 `toast.success(...)` 一发即走。
 */
export const useToastStore = create<ToastState>((set, get) => ({
  items: [],
  push: (message, tone = 'info', duration = TOAST_DURATION) => {
    const id = ++seq
    set((s) => ({ items: [{ id, tone, message }, ...s.items].slice(0, MAX_TOASTS) }))
    if (duration > 0) window.setTimeout(() => get().dismiss(id), duration)
    return id
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
  clear: () => set({ items: [] }),
}))

/** 组件外也能用的便捷入口：`toast.success('已复制')` */
export const toast = {
  show: (message: string, tone: ToastTone = 'info', duration?: number) =>
    useToastStore.getState().push(message, tone, duration),
  success: (message: string, duration?: number) => useToastStore.getState().push(message, 'success', duration),
  error: (message: string, duration?: number) => useToastStore.getState().push(message, 'error', duration),
  info: (message: string, duration?: number) => useToastStore.getState().push(message, 'info', duration),
  warning: (message: string, duration?: number) => useToastStore.getState().push(message, 'warning', duration),
}
