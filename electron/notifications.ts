/**
 * 桌面通知泵（工单 02 · S4）。
 *
 * 引擎是 sidecar，自己弹不了 Windows 通知；而监控是常驻盯屏的，
 * 没人会一直开着实例窗口等着收。所以由**主进程**（跟着应用常驻）定时去 outbox 取，
 * 窗口关了、最小化到托盘也照样收得到。
 *
 * 设备层（真弹窗、角标）按项目约定只人工验收，可测部分全靠注入：
 * `fetchOutbox` / `fetchUnread` / `show` / `setBadge` 都是参数。
 */
export interface OutboxItem {
  id: number
  instanceId: string
  ruleId: string
  matchedBy: string
  level: string
  title: string
  detail: string
  at: string
}

export interface NotifyDeps {
  /** 取 `since` 之后的待发通知，回 (列表, 新游标)。取过的不再重复。 */
  fetchOutbox: (since: number) => Promise<{ items: OutboxItem[]; cursor: number }>
  /** 未读命中数，角标用它 */
  fetchUnread: () => Promise<number>
  show: (item: OutboxItem) => void
  setBadge: (count: number) => void
  /** 引擎还没起来 / 网络抖一下：记一句就行，绝不能让泵停摆 */
  onError?: (err: unknown) => void
}

export interface NotifyPump {
  stop: () => void
}

export function createNotifyPump(deps: NotifyDeps, intervalMs = 2000): NotifyPump {
  let since = 0
  /** -1 = 还没取过，避免开局就把 0 写进角标（那是「没设置」不是「没有未读」） */
  let badge = -1
  let stopped = false
  let busy = false

  const tick = async () => {
    // 上一轮还没回来就别叠下一轮：慢一轮会把后面的轮询堆成一串并发请求
    if (stopped || busy) return
    busy = true
    try {
      const { items, cursor } = await deps.fetchOutbox(since)
      since = cursor
      for (const it of items) deps.show(it)

      const unread = await deps.fetchUnread()
      if (unread !== badge) {
        badge = unread
        deps.setBadge(unread)
      }
    } catch (err) {
      deps.onError?.(err)
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => void tick(), intervalMs)
  // 立马拉一次：命中到弹窗的预算是 3 秒，不该先白等一个轮询周期
  void tick()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
