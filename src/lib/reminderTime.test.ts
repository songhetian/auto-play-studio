import { describe, expect, it } from 'vitest'
import { dueReminders, isDue, relativeTime, urgencyOf } from './reminderTime'
import type { Reminder } from './reminderTime'

/** 固定一个"现在"，让相对时间断言可重复（不用真实时钟，避免测试抖动） */
const NOW = new Date('2026-10-05T10:00:00')

const rem = (iso: string): Reminder => ({
  id: iso,
  content: 'x',
  at: iso,
  category: 'work',
  done: false,
})

describe('isDue', () => {
  it('到点了且未完成才算到期', () => {
    expect(isDue(rem('2026-10-05T10:00:00'), NOW)).toBe(true)
    expect(isDue(rem('2026-10-05T10:01:00'), NOW)).toBe(false)
  })

  it('已完成的不再弹——否则关不掉', () => {
    expect(isDue({ ...rem('2026-10-05T09:59:00'), done: true }, NOW)).toBe(false)
  })

  it('稍后 snooze 期间不弹，到点后再弹', () => {
    const snoozed: Reminder = {
      ...rem('2026-10-05T09:00:00'),
      snoozedUntil: '2026-10-05T10:05:00',
    }
    expect(isDue(snoozed, NOW)).toBe(false)
    expect(isDue(snoozed, new Date('2026-10-05T10:05:00'))).toBe(true)
  })

  it('snooze 已过期不影响原始到期判定', () => {
    const snoozed: Reminder = {
      ...rem('2026-10-05T09:00:00'),
      snoozedUntil: '2026-10-05T09:30:00',
    }
    expect(isDue(snoozed, NOW)).toBe(true)
  })
})

describe('dueReminders', () => {
  it('只返回到期的：未到点/已完成/未来 snooze 都要排除', () => {
    const list: Reminder[] = [
      rem('2026-10-05T09:00:00'), // 到期
      rem('2026-10-05T11:00:00'), // 未到
      { ...rem('2026-10-05T08:00:00'), done: true }, // 已完成
      { ...rem('2026-10-05T09:30:00'), snoozedUntil: '2026-10-05T10:30:00' }, // snooze 中
    ]
    expect(dueReminders(list, NOW).map((r) => r.at)).toEqual(['2026-10-05T09:00:00'])
  })

  it('多个同时到期按设定时间先后返回', () => {
    const list = [rem('2026-10-05T09:30:00'), rem('2026-10-05T08:00:00'), rem('2026-10-05T09:00:00')]
    expect(dueReminders(list, NOW).map((r) => r.at)).toEqual([
      '2026-10-05T08:00:00',
      '2026-10-05T09:00:00',
      '2026-10-05T09:30:00',
    ])
  })
})

describe('relativeTime', () => {
  it('过去的用"已逾期 X 分钟/小时/天"', () => {
    expect(relativeTime('2026-10-05T09:30:00', NOW)).toBe('已逾期 30 分钟')
    expect(relativeTime('2026-10-05T07:00:00', NOW)).toBe('已逾期 3 小时')
    expect(relativeTime('2026-10-03T10:00:00', NOW)).toBe('已逾期 2 天')
  })

  it('未来的用"剩 X 分钟/小时/天"', () => {
    expect(relativeTime('2026-10-05T10:12:00', NOW)).toBe('剩 12 分钟')
    expect(relativeTime('2026-10-05T15:00:00', NOW)).toBe('剩 5 小时')
    expect(relativeTime('2026-10-07T10:00:00', NOW)).toBe('剩 2 天')
  })

  it('一分钟内不说"剩 0 分钟"，说马上到', () => {
    expect(relativeTime('2026-10-05T10:00:30', NOW)).toBe('马上到')
  })
})

describe('urgencyOf', () => {
  it('按剩余时间分档，供标签着色（quiet/normal/soon/overdue）', () => {
    expect(urgencyOf('2026-10-07T10:00:00', NOW)).toBe('quiet')
    expect(urgencyOf('2026-10-05T14:00:00', NOW)).toBe('normal')
    expect(urgencyOf('2026-10-05T10:10:00', NOW)).toBe('soon')
    expect(urgencyOf('2026-10-05T09:00:00', NOW)).toBe('overdue')
  })

  it('已逾期的哪怕只过一秒也算 overdue，而不是 soon', () => {
    expect(urgencyOf('2026-10-05T09:59:59', NOW)).toBe('overdue')
  })
})
