import { describe, expect, it } from 'vitest'
import { aggregateByRound, shouldAggregate } from './hitGrouping'
import type { HitEvent } from '@/lib/hitEvents'

/**
 * 同一轮扫描里的同类命中聚合成一条。
 *
 * 为什么要聚合：一次监控扫到 20 个目标，此前会弹 20 次横幅糊一脸，
 * 而它们其实是"同一件事发生了很多次"——用户需要知道的是"20 次"，不是 20 条通知。
 *
 * 轮次怎么判：**用引擎给的 ts 分组**（同一轮扫描写出的命中 ts 相同或紧邻），
 * 不用"固定 30 秒窗口"——窗口是拍的，会把两轮独立的扫描误并成一轮，
 * 那时候"20 次"其实是"10 次 + 10 次"，数字就骗人了。
 */
const hit = (over: Partial<HitEvent> = {}): HitEvent => ({
  id: 1,
  instanceId: 'I1',
  tool: 'monitor',
  ruleId: 'img_a',
  matchedBy: 'image',
  level: 'alert',
  title: '订单页面模板',
  detail: '',
  similarity: 0.94,
  rect: null,
  snapshot: '',
  notified: {},
  read: false,
  disposition: 'pending',
  ackAt: '',
  ts: '2026-10-05 10:22:31',
  ...over,
})

describe('shouldAggregate', () => {
  it('图片监控这类连续画面命中聚合', () => {
    // 同一张模板在同一轮里匹配到多处，是最常见的"刷屏"来源
    expect(shouldAggregate({ tool: 'monitor' } as HitEvent)).toBe(true)
  })

  it('敏感词不聚合_每次都可能是不同话术必须逐条看', () => {
    // 聚合了用户就只看到"敏感词命中 20 次"，具体说了什么被压掉了
    expect(shouldAggregate({ tool: 'guard' } as HitEvent)).toBe(false)
  })

  it('视频与图片识别聚合_同样是画面目标', () => {
    expect(shouldAggregate({ tool: 'image' } as HitEvent)).toBe(true)
    expect(shouldAggregate({ tool: 'video' } as HitEvent)).toBe(true)
  })

  it('不认识的工具不聚合_宁可多弹也不该替用户做合并决策', () => {
    expect(shouldAggregate({ tool: '未来工具' } as HitEvent)).toBe(false)
  })
})

describe('aggregateByRound', () => {
  it('同轮同类命中合成一条_标题带次数', () => {
    const groups = aggregateByRound([
      hit({ id: 1, ts: '2026-10-05 10:22:31' }),
      hit({ id: 2, ts: '2026-10-05 10:22:31' }),
      hit({ id: 3, ts: '2026-10-05 10:22:31' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(3)
    // 组内从新到旧：同 ts 时按 id 降序（最后写入的排最前）
    expect(groups[0].events.map((e) => e.id)).toEqual([3, 2, 1])
  })

  it('不同轮次分开_不能把两轮独立扫描误并成一轮', () => {
    const groups = aggregateByRound([
      hit({ id: 1, ts: '2026-10-05 10:22:31' }),
      hit({ id: 2, ts: '2026-10-05 10:25:04' }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('不同工具分开_图片命中与敏感词不该并成一条', () => {
    const groups = aggregateByRound([
      hit({ id: 1, tool: 'monitor', ts: '2026-10-05 10:22:31' }),
      hit({ id: 2, tool: 'guard', ts: '2026-10-05 10:22:31' }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('同轮不同规则分开_两个素材各自的目标不该混成一个数字', () => {
    const groups = aggregateByRound([
      hit({ id: 1, ruleId: 'img_a', ts: '2026-10-05 10:22:31' }),
      hit({ id: 2, ruleId: 'img_b', ts: '2026-10-05 10:22:31' }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('敏感词逐条不合并_每条一个 group、count 恒为 1', () => {
    const groups = aggregateByRound([
      hit({ id: 1, tool: 'guard', title: '最好', ts: '2026-10-05 10:22:31' }),
      hit({ id: 2, tool: 'guard', title: '最低', ts: '2026-10-05 10:22:31' }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.count === 1)).toBe(true)
  })

  it('组内取最新一条作为代表_展示的是最后一次发生', () => {
    // 同一轮 = 同一个 ts，代表取**最后写入**的那条（id 最大的那条）
    const groups = aggregateByRound([
      hit({ id: 1, ts: '2026-10-05 10:22:31', detail: '第1次' }),
      hit({ id: 2, ts: '2026-10-05 10:22:31', detail: '第2次' }),
    ])
    expect(groups[0].representative.detail).toBe('第2次')
    expect(groups[0].events[0].detail).toBe('第2次')
  })

  it('时间倒序输入也能正确分组', () => {
    // 轮询接口可能给出乱序的（按 id 倒序取），不该影响分组结果
    const groups = aggregateByRound([
      hit({ id: 3, ts: '2026-10-05 10:22:31' }),
      hit({ id: 1, ts: '2026-10-05 10:22:31' }),
      hit({ id: 2, ts: '2026-10-05 10:25:04' }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.find((g) => g.count === 2)?.events.map((e) => e.id).sort()).toEqual([1, 3])
  })

  it('空输入返回空数组', () => {
    expect(aggregateByRound([])).toEqual([])
  })

  it('单条命中的 count 为 1_界面不显示"1 次"这种噪音', () => {
    const groups = aggregateByRound([hit()])
    expect(groups[0].count).toBe(1)
    expect(groups[0].aggregated).toBe(false)
  })

  it('聚合成组时 aggregated 为 true_界面据此决定要不要显示"展开"', () => {
    const groups = aggregateByRound([hit({ id: 1 }), hit({ id: 2 })])
    expect(groups[0].aggregated).toBe(true)
  })

  it('ts 缺失时不聚合_宁可分开也不要把不同时间的事并成一轮', () => {
    const groups = aggregateByRound([
      hit({ id: 1, ts: '' }),
      hit({ id: 2, ts: '' }),
    ])
    expect(groups).toHaveLength(2)
  })
})
