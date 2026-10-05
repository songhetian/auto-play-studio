/**
 * 提醒的时间计算：什么时候该弹、怎么跟人话描述"还有多久"。
 *
 * 全部是纯函数、不碰 store 也不碰时钟（`now` 一律从参数进），所以同一组断言
 * 可以在任何时刻重复跑——真时钟会让"剩 12 分钟"这种测试半夜就红。
 *
 * 单位的选择：分/小时/天三档，不显示秒也不显示"剩 0 分钟"——后者看着像坏了。
 */

/** 提醒分类。决定弹窗与列表的色条，跟原型里的分类一一对应。 */
export type ReminderCategory = 'work' | 'logistics' | 'service' | 'personal'

export interface Reminder {
  id: string
  /** 提醒内容（一句话） */
  content: string
  /** 到期时间，ISO 本地时间串，如 '2026-10-05T15:00' */
  at: string
  category: ReminderCategory
  done: boolean
  /** 「稍后 N 分钟」后的再次提醒时刻；没有则为空串 */
  snoozedUntil?: string
  /**
   * 创建时间。倒计时进度条靠它算"还剩多少"（分母是从创建到到期的总跨度）。
   * 老数据可能没有 —— 缺了就按满格处理，不显示成一个负数或 0%。
   */
  createdAt?: string
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** 急迫度：给标签配色用，避免在页面里散落一堆时间比较 */
export type Urgency = 'quiet' | 'normal' | 'soon' | 'overdue'

/** 15 分钟内算 soon，用来在列表里高亮"马上要到了" */
const SOON_MS = 15 * MIN

function ts(iso: string): number {
  // 非法时间串返回 NaN，后续比较都为 false —— 宁可漏弹也不弹一个 NaN 的东西
  return new Date(iso).getTime()
}

/**
 * 此刻是否该为这条提醒弹窗。
 *
 * 三个条件缺一不可：到点了、没完成、不在稍后等待期内。
 */
export function isDue(r: Reminder, now: Date = new Date()): boolean {
  if (r.done) return false
  const n = now.getTime()
  if (!(ts(r.at) <= n)) return false
  if (r.snoozedUntil && n < ts(r.snoozedUntil)) return false
  return true
}

/** 取出全部该弹的，按设定时间从早到晚——先到期的先问 */
export function dueReminders(list: readonly Reminder[], now: Date = new Date()): Reminder[] {
  return list.filter((r) => isDue(r, now)).sort((a, b) => ts(a.at) - ts(b.at))
}

/** 把时长说成中文人话：过去说"已逾期"、未来说"剩"，一分钟内说"马上到" */
export function relativeTime(at: string, now: Date = new Date()): string {
  const diff = now.getTime() - ts(at)
  const overdue = diff > 0
  const abs = Math.abs(diff)
  if (abs < MIN) return '马上到'

  let body: string
  if (abs < HOUR) body = `${Math.floor(abs / MIN)} 分钟`
  else if (abs < DAY) body = `${Math.floor(abs / HOUR)} 小时`
  else body = `${Math.floor(abs / DAY)} 天`

  return overdue ? `已逾期 ${body}` : `剩 ${body}`
}

/** 急迫度分档：已过期 > 15 分钟内 > 今天内 > 更远 */
export function urgencyOf(at: string, now: Date = new Date()): Urgency {
  const diff = ts(at) - now.getTime()
  if (diff <= 0) return 'overdue'
  if (diff <= SOON_MS) return 'soon'
  if (diff <= DAY) return 'normal'
  return 'quiet'
}

/** 倒计时：弹窗底部进度条的数据源 */
export interface Countdown {
  /** 剩余占比 0~100，100 = 刚创建，0 = 已到期 */
  percent: number
  /** 距离到期还有多少毫秒，已到期为 0（给倒计时动画用） */
  remainingMs: number
}

/**
 * 还剩多少。
 *
 * 分母是「从**创建**到到期」的总跨度，不是"从现在起一小时"这种拍脑袋的尺度 ——
 * 设了 3 小时后才到的提醒，不该一打开就显示 90%（那会让人以为快到了）。
 * 缺 createdAt（老数据）时按满格处理：宁可显示"还早"，也不显示成"已经晚了"。
 */
export function countdownOf(r: Reminder, now: Date = new Date()): Countdown {
  const due = ts(r.at)
  const n = now.getTime()
  const remainingMs = Math.max(0, due - n)

  const created = r.createdAt ? ts(r.createdAt) : NaN
  if (Number.isNaN(created)) return { percent: remainingMs > 0 ? 100 : 0, remainingMs }
  const span = due - created
  if (!(span > 0)) return { percent: 0, remainingMs }

  const left = Math.max(0, Math.min(span, remainingMs))
  return { percent: Math.round((left / span) * 100), remainingMs }
}

/** 弹窗里的倒计时文案：已到期说"已逾期"，否则说"还剩" */
export function remainLabel(at: string, now: Date = new Date()): string {
  const diff = ts(at) - now.getTime()
  if (diff <= 0) return relativeTime(at, now)
  if (diff < MIN) return '马上到'
  if (diff < HOUR) return `还剩 ${Math.floor(diff / MIN)} 分钟`
  if (diff < DAY) return `还剩 ${Math.floor(diff / HOUR)} 小时`
  return `还剩 ${Math.floor(diff / DAY)} 天`
}
