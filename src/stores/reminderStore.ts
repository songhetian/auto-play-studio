import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { dueReminders, type Reminder, type ReminderCategory } from '@/lib/reminderTime'

/**
 * 定时提醒的持久化状态。
 *
 * 纯前端闭环：提醒存在 localStorage，AppShell 顶层定时扫到期项弹居中拦截框。
 * 这样不开后端、不依赖引擎进程，App 一开就生效；代价是**关掉 App 不会提醒**，
 * 那是 OS 通知/计划任务的活儿，不在 v1 范围（见 docs/prd-reminders.md）。
 *
 * 完成用 `done` 标记而不是删除：逾期台账要能回看"这条上周处理过没有"。
 */
interface ReminderState {
  reminders: Reminder[]
  /** 新增一条。内容为空则忽略 —— 不弹空卡片。返回新 id 方便立刻定位 */
  add: (r: Omit<Reminder, 'id' | 'done'> & { id?: string }) => string
  /** 标记完成（保留在历史里）；id 不存在时是安全空操作 */
  complete: (id: string) => void
  /** 「稍后 N 分钟」：推迟再次提醒，不标记完成 */
  snooze: (id: string, minutes?: number, now?: Date) => void
  remove: (id: string) => void
  /** 未完成（待办 + 已逾期都算） */
  pending: () => Reminder[]
  /** 此刻该弹的，按时间先后 */
  due: (now?: Date) => Reminder[]
  /** 该弹的条数，给铃铛角标用 */
  dueCount: (now?: Date) => number
  /** 15 分钟内将到期的条数，列表页用它提示"马上要到了" */
  upcomingSoon: (now?: Date) => number
}

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export const useReminderStore = create<ReminderState>()(
  persist(
    (set, get) => ({
      reminders: [],

      add: (r) => {
        const content = (r.content ?? '').trim()
        if (!content) return ''
        const id = r.id ?? newId()
        set((s) => ({
          reminders: [
            ...s.reminders,
            // createdAt 是倒计时进度条的分母起点，缺了它进度条永远满格
            { ...r, id, content, done: false, createdAt: r.createdAt || new Date().toISOString() },
          ],
        }))
        return id
      },

      complete: (id) =>
        set((s) => ({
          reminders: s.reminders.map((r) => (r.id === id ? { ...r, done: true, snoozedUntil: '' } : r)),
        })),

      snooze: (id, minutes = 5, now = new Date()) =>
        set((s) => ({
          reminders: s.reminders.map((r) => {
            if (r.id !== id) return r
            const until = new Date(now.getTime() + minutes * 60_000)
            return { ...r, snoozedUntil: isoLocal(until) }
          }),
        })),

      remove: (id) => set((s) => ({ reminders: s.reminders.filter((r) => r.id !== id) })),

      pending: () => get().reminders.filter((r) => !r.done),

      due: (now) => dueReminders(get().reminders, now),

      dueCount: (now) => dueReminders(get().reminders, now).length,

      upcomingSoon: (now = new Date()) => {
        const n = now.getTime()
        return get().reminders.filter((r) => {
          if (r.done) return false
          const diff = new Date(r.at).getTime() - n
          return diff > 0 && diff <= 15 * 60_000
        }).length
      },
    }),
    { name: 'autoplay.reminders', version: 1 },
  ),
)

/**
 * 本地时间 ISO 串（`2026-10-05T10:05:00`），和 <input type="datetime-local"> 同格式。
 * 不能用 toISOString()：那是 UTC，往回减 8 小时，"现在"能存成 8 小时前。
 */
export function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export type { Reminder, ReminderCategory }
