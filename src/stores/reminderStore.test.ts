import { beforeEach, describe, expect, it } from 'vitest'
import { useReminderStore } from './reminderStore'
import type { Reminder } from '@/lib/reminderTime'

const rem = (over: Partial<Reminder> = {}): Reminder => ({
  id: 'r1',
  content: '给王经理发周报',
  at: '2026-10-05T18:00',
  category: 'work',
  done: false,
  ...over,
})

/** 每个用例都从"有一条 r1"的干净状态出发，避免相互污染 */
const seed = (list: Reminder[]) => useReminderStore.setState({ reminders: list })

beforeEach(() => {
  useReminderStore.setState({ reminders: [rem()] })
})

describe('新增', () => {
  it('add 追加一条并分配 id', () => {
    useReminderStore.getState().add(rem({ id: 'x', content: '核对退款台账' }))
    const list = useReminderStore.getState().reminders
    expect(list).toHaveLength(2)
    expect(list[1].content).toBe('核对退款台账')
    expect(list[1].id).toBeTruthy()
  })

  it('add 给未指定的字段补默认值（done=false、无 snooze）', () => {
    useReminderStore.getState().add({ id: 'y', content: 'a', at: '2026-10-05T09:00', category: 'work' })
    const added = useReminderStore.getState().reminders[1]
    expect(added.done).toBe(false)
    expect(added.snoozedUntil).toBeFalsy()
  })

  it('空内容不入库——免得弹一个空卡片', () => {
    useReminderStore.getState().add(rem({ content: '   ' }))
    expect(useReminderStore.getState().reminders).toHaveLength(1)
  })

  it('add 自动盖上 createdAt_倒计时进度条靠它算还剩多少', () => {
    useReminderStore.getState().add(rem({ id: 'n', content: 'a' }))
    const added = useReminderStore.getState().reminders[1]
    // 没有它，进度条的分母为 0，永远显示满格
    expect(added.createdAt).toBeTruthy()
    expect(Number.isNaN(new Date(added.createdAt as string).getTime())).toBe(false)
  })

  it('已有 createdAt 不被覆盖_用户建好后放了很久才到期也是原跨度', () => {
    const made = '2026-09-01T08:00:00'
    useReminderStore.getState().add(rem({ id: 'n', content: 'a', createdAt: made }))
    expect(useReminderStore.getState().reminders[1].createdAt).toBe(made)
  })
})

describe('完成 / 删除', () => {
  it('complete 标记完成而不是删除，历史还查得到', () => {
    useReminderStore.getState().complete('r1')
    const list = useReminderStore.getState().reminders
    expect(list).toHaveLength(1)
    expect(list[0].done).toBe(true)
  })

  it('complete 不存在的 id 是安全空操作', () => {
    useReminderStore.getState().complete('nope')
    expect(useReminderStore.getState().reminders[0].done).toBe(false)
  })

  it('remove 真的删掉', () => {
    useReminderStore.getState().remove('r1')
    expect(useReminderStore.getState().reminders).toHaveLength(0)
  })
})

describe('稍后提醒', () => {
  it('snooze 把再次提醒推到 now+分钟', () => {
    const now = new Date('2026-10-05T10:00:00')
    useReminderStore.getState().snooze('r1', 5, now)
    expect(useReminderStore.getState().reminders[0].snoozedUntil).toBe('2026-10-05T10:05:00')
  })

  it('snooze 不标记完成——这条还欠着', () => {
    useReminderStore.getState().snooze('r1', 5, new Date('2026-10-05T10:00:00'))
    expect(useReminderStore.getState().reminders[0].done).toBe(false)
  })
})

describe('派生数据', () => {
  it('pending 只给未完成的，已完成不进列表', () => {
    seed([rem(), rem({ id: 'r2', content: 'b', done: true })])
    expect(useReminderStore.getState().pending().map((r) => r.id)).toEqual(['r1'])
  })

  it('due 现在就该弹的', () => {
    seed([rem({ at: '2026-10-05T09:00:00' }), rem({ id: 'r2', at: '2026-10-05T23:00:00' })])
    const now = new Date('2026-10-05T10:00:00')
    expect(useReminderStore.getState().due(now).map((r) => r.id)).toEqual(['r1'])
  })

  it('dueCount 统计该弹的条数，给铃铛角标用', () => {
    seed([
      rem({ at: '2026-10-05T09:00:00' }),
      rem({ id: 'r2', at: '2026-10-05T09:30:00' }),
      rem({ id: 'r3', at: '2026-10-05T23:00:00' }),
    ])
    expect(useReminderStore.getState().dueCount(new Date('2026-10-05T10:00:00'))).toBe(2)
  })

  it('upcomingSoon 只数 15 分钟内将到期的未完成项', () => {
    seed([
      rem({ at: '2026-10-05T10:10:00' }),
      rem({ id: 'r2', at: '2026-10-05T14:00:00' }),
      rem({ id: 'r3', at: '2026-10-05T10:05:00', done: true }),
    ])
    expect(useReminderStore.getState().upcomingSoon(new Date('2026-10-05T10:00:00'))).toBe(1)
  })
})
