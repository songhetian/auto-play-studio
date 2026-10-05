import { describe, expect, it } from 'vitest'
import { countdownOf, remainLabel } from './reminderTime'
import type { Reminder } from './reminderTime'

const NOW = new Date('2026-10-05T10:00:00')

/**
 * 到期倒计时：弹窗底部的进度条 + 「剩多久」。
 *
 * 为什么要它：定时提醒的视觉权重必须与"它必须被处理"这件事相称。
 * 之前它只有一段文字 + 两个按钮，看上去比"命中横幅"还轻 ——
 * 而它恰恰是唯一**不能自动消失**的那类提醒。
 *
 * 进度条的分母是「从创建到到期」的总跨度：设了 3 小时后才到的提醒，
 * 不该一打开就显示 90%（那会让人以为快到了、结果还早得很）。
 */
const r = (createdAt: string, at: string): Reminder => ({
  id: 'x',
  content: 'x',
  at,
  category: 'work',
  done: false,
  createdAt,
})

describe('countdownOf', () => {
  it('刚创建时是满的_100%', () => {
    // "10:00 刚创建、12:00 到期" 此刻就该显示满格，而不是 0
    expect(countdownOf(r('2026-10-05T10:00', '2026-10-05T12:00'), NOW).percent).toBe(100)
  })

  it('已到期时是 0%', () => {
    expect(countdownOf(r('2026-10-05T07:00', '2026-10-05T09:00'), NOW).percent).toBe(0)
  })

  it('跨度中间是一半', () => {
    // 8:00 创建、12:00 到期，10:00 正好走了一半
    expect(countdownOf(r('2026-10-05T08:00', '2026-10-05T12:00'), NOW).percent).toBe(50)
  })

  it('没有创建时间时不知道跨度_退回满格而不是算成负数', () => {
    // 老数据可能没有 createdAt；此时报 0% 会误导成"已经晚了"
    const c = countdownOf(r('', '2026-10-05T12:00'), NOW)
    expect(c.percent).toBe(100)
  })

  it('创建时间晚于到期时间（用户设了过去时间）_不崩且回到 0', () => {
    expect(countdownOf(r('2026-10-05T11:00', '2026-10-05T10:00'), NOW).percent).toBe(0)
  })

  it('percent 永远落在 0~100', () => {
    // 早就过期的：0%
    expect(countdownOf(r('2020-01-01T00:00', '2026-10-05T10:00'), NOW).percent).toBe(0)
    // 1 小时跨度、已过 1 分钟：98%，不是 100 —— 进度条本来就在走
    expect(countdownOf(r('2026-10-05T09:59', '2026-10-05T10:59'), NOW).percent).toBe(98)
  })

  it('剩余毫秒是给倒计时动画用的_已到期为 0', () => {
    const c = countdownOf(r('2026-10-05T09:00', '2026-10-05T10:00'), NOW)
    expect(c.remainingMs).toBe(0)
    expect(countdownOf(r('2026-10-05T09:00', '2026-10-05T11:00'), NOW).remainingMs).toBe(60 * 60_000)
  })
})

describe('remainLabel', () => {
  it('超过一天说天数', () => {
    expect(remainLabel('2026-10-07T10:00:00', NOW)).toBe('还剩 2 天')
  })

  it('一天内说小时与分钟', () => {
    expect(remainLabel('2026-10-05T15:00:00', NOW)).toBe('还剩 5 小时')
    expect(remainLabel('2026-10-05T10:12:00', NOW)).toBe('还剩 12 分钟')
  })

  it('不足一分钟说马上到', () => {
    expect(remainLabel('2026-10-05T10:00:30', NOW)).toBe('马上到')
  })

  it('已到期说已逾期_而不是还剩负数', () => {
    expect(remainLabel('2026-10-05T09:30:00', NOW)).toBe('已逾期 30 分钟')
  })
})
