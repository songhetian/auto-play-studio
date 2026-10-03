import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createNotifyPump, type NotifyDeps, type OutboxItem } from './notifications'

/**
 * Seam：桌面通知泵（工单 02 · S4）。
 *
 * 真弹窗与角标是设备层（Electron `Notification` / 任务栏），按项目约定只人工验收；
 * 这里测的是「取 → 弹 → 计数」这条链路，四个外部依赖全部注入假实现。
 *
 * 期望值全部手写。
 */
const item = (id: number, title = `命中 ${id}`): OutboxItem => ({
  id,
  instanceId: 'M1',
  ruleId: 'img_a',
  matchedBy: 'image',
  level: 'alert',
  title,
  detail: '相似度 0.93',
  at: '2026-10-03 23:00:00',
})

function makeDeps(over: Partial<NotifyDeps> = {}) {
  const out: NotifyDeps & { shown: OutboxItem[]; badges: number[]; errors: unknown[] } = {
    shown: [],
    badges: [],
    errors: [],
    fetchOutbox: async () => ({ items: [], cursor: 0 }),
    fetchUnread: async () => 0,
    show: (it) => out.shown.push(it),
    setBadge: (n) => out.badges.push(n),
    onError: (e) => out.errors.push(e),
    ...over,
  }
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('通知泵', () => {
  it('把待发通知逐条弹出来', async () => {
    const d = makeDeps({ fetchOutbox: async () => ({ items: [item(1), item(2)], cursor: 2 }) })
    const pump = createNotifyPump(d, 2000)

    await vi.advanceTimersByTimeAsync(0)
    expect(d.shown.map((i) => i.title)).toEqual(['命中 1', '命中 2'])
    pump.stop()
  })

  it('启动时立刻拉一次，不等第一个轮询周期', async () => {
    const d = makeDeps({ fetchOutbox: async () => ({ items: [item(1)], cursor: 1 }) })
    const pump = createNotifyPump(d, 5000)

    // 还没推进任何时间就该已经弹了：命中后 3 秒内可见，别让第一个周期吃掉一半预算
    await vi.advanceTimersByTimeAsync(0)
    expect(d.shown).toHaveLength(1)
    pump.stop()
  })

  it('游标只往前走，同一条不会弹第二次', async () => {
    const seen: number[] = []
    const d = makeDeps({
      fetchOutbox: async (since) => {
        seen.push(since)
        return since === 0 ? { items: [item(1)], cursor: 7 } : { items: [], cursor: 7 }
      },
    })
    const pump = createNotifyPump(d, 1000)

    await vi.advanceTimersByTimeAsync(0) // 创建时立刻那一次
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual([0, 7, 7]), '第一次之后都带上一次拿到的游标'
    expect(d.shown.map((i) => i.id)).toEqual([1]), '取过的不再弹'
    pump.stop()
  })

  it('引擎抖一下不能让泵停摆', async () => {
    let calls = 0
    const d = makeDeps({
      fetchOutbox: async () => {
        calls += 1
        if (calls === 1) throw new Error('连接被拒')
        return { items: [item(1)], cursor: 1 }
      },
    })
    const pump = createNotifyPump(d, 1000)

    await vi.advanceTimersByTimeAsync(0) // 创建时立刻那一次：这次失败
    expect(d.errors).toHaveLength(1), '失败要留个记录，不能静默'
    expect(d.shown).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1000)
    expect(d.shown.map((i) => i.title)).toEqual(['命中 1']), '下一轮必须照常工作'
    pump.stop()
  })

  it('未读数变了才更新角标，没变就不重复设', async () => {
    let unread = 0
    const d = makeDeps({ fetchUnread: async () => unread })
    const pump = createNotifyPump(d, 1000)

    await vi.advanceTimersByTimeAsync(1000)
    unread = 2
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(d.badges).toEqual([0, 2]), '同一个数不重复设，变的时候才设'
    pump.stop()
  })

  it('停止之后不再轮询', async () => {
    let calls = 0
    const d = makeDeps({
      fetchOutbox: async () => {
        calls += 1
        return { items: [], cursor: 0 }
      },
    })
    const pump = createNotifyPump(d, 1000)

    await vi.advanceTimersByTimeAsync(1000) // 创建时那一次 + 一个周期
    pump.stop()
    const atStop = calls
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(atStop), '停止之后一次都不能再取'
  })

  it('上一轮还没回来时不叠下一轮', async () => {
    // 用对象持有 resolve：直接 `let release` 会被 TS 收窄成 null（赋值发生在回调里）
    const gate: { release?: () => void } = {}
    let calls = 0
    const d = makeDeps({
      fetchOutbox: () =>
        new Promise((resolve) => {
          calls += 1
          gate.release = () => resolve({ items: [], cursor: 0 })
        }),
    })
    const pump = createNotifyPump(d, 100)

    void vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toBe(1), '慢一轮就把后面的轮询吃掉，否则会堆成一串并发请求'
    gate.release?.()
    pump.stop()
  })
})
