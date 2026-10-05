import type { HitEvent } from '@/lib/hitEvents'

/**
 * 同一轮扫描里的同类命中聚合成一条。
 *
 * 为什么要聚合：一次监控扫到 20 个目标，此前会弹 20 次横幅糊一脸，
 * 而它们其实是"同一件事发生了很多次"——用户真正需要知道的是"20 次"，
 * 不是 20 条几乎一样的通知。
 *
 * **轮次怎么判**：用引擎写的 `ts`（秒级时间戳）分组。同一轮扫描写出的命中
 * ts 完全相同，不同轮之间至少差一轮间隔。
 * 不用"固定 30 秒窗口"——窗口是拍的，会把两轮独立扫描误并成一轮，
 * 那时"20 次"其实是"10 次 + 10 次"，数字就在骗人了。
 *
 * **谁聚合**：只有"画面类"聚合。敏感词**逐条弹**——每一次都可能是另一句
 * 不同的话术，聚合起来用户就看不到自己究竟说了什么，那这条提醒就白发了。
 */

/** 哪些工具的命中可以合并成一条 */
const AGGREGATABLE = new Set(['monitor', 'image', 'video', 'intent'])

export function shouldAggregate(hit: Pick<HitEvent, 'tool'>): boolean {
  return AGGREGATABLE.has(hit.tool)
}

export interface RoundGroup {
  /** 这一组代表哪一次事件（组内最新的一条） */
  representative: HitEvent
  /** 组内全部命中，按时间从新到旧 */
  events: HitEvent[]
  /** 合并了多少条（含代表自身） */
  count: number
  /** 值得显示"展开 N 条"吗：只有真的合并过才为 true */
  aggregated: boolean
}

/** 分组键：工具 + 规则 + 轮次。少任何一个都会把不同的事并到一起。 */
function groupKeyOf(h: HitEvent): string | null {
  // ts 缺失时不给键 —— 宁可拆开，也不把两件时间不明的事并成"一次"
  if (!h.ts) return null
  return `${h.tool}|${h.ruleId}|${h.ts}`
}

export function aggregateByRound(hits: readonly HitEvent[]): RoundGroup[] {
  const buckets = new Map<string, HitEvent[]>()
  const order: string[] = []

  for (const h of hits) {
    if (!shouldAggregate(h)) {
      // 不聚合的：每条自带一个唯一键，天然各自成组
      const k = `solo-${order.length}-${h.id}`
      buckets.set(k, [h])
      order.push(k)
      continue
    }
    const k = groupKeyOf(h)
    if (k === null) {
      const kk = `notime-${order.length}-${h.id}`
      buckets.set(kk, [h])
      order.push(kk)
      continue
    }
    if (!buckets.has(k)) {
      buckets.set(k, [])
      order.push(k)
    }
    buckets.get(k)!.push(h)
  }

  return order.map((k) => {
    // 同 ts（同一轮）时 ts 排序定不了序，用 id 兜底 —— id 自增，最后写入的 id 最大，
    // 展示它才符合"最近一次命中"的直觉。
    const events = [...buckets.get(k)!].sort(
      (a, b) => b.ts.localeCompare(a.ts) || b.id - a.id,
    )
    return {
      representative: events[0],
      events,
      count: events.length,
      aggregated: events.length > 1,
    }
  })
}
