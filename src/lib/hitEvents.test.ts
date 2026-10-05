import { describe, it, expect } from 'vitest'
import {
  ACK_TIMEOUT_MS,
  dispositionOf,
  hitEventQuery,
  notifiedText,
  parseHitTs,
  timeoutPendingCount,
} from './hitEvents'

/**
 * Seam：命中事件列表的纯逻辑（工单 02 · S7）。
 *
 * 页面本身是设备层之外的展示层，不测；这两块是它最容易出错的地方：
 * 查询串（少带/多带一个参数，筛选就静默失效）与通知结果文案
 * （ok / fail / skip 三种结局要说人话）。
 *
 * 期望值全部手写。
 */
describe('查询串', () => {
  it('没有筛选时不带任何参数', () => {
    expect(hitEventQuery({})).toBe('')
  })

  it('空值不进查询串', () => {
    expect(hitEventQuery({ instanceId: '', tool: undefined, level: '' })).toBe('')
  })

  it('按实例筛选', () => {
    expect(hitEventQuery({ instanceId: 'M1' })).toBe('instanceId=M1')
  })

  it('多个条件一起带', () => {
    expect(hitEventQuery({ instanceId: 'M1', tool: 'monitor', level: 'alert' })).toBe(
      'instanceId=M1&tool=monitor&level=alert',
    )
  })

  it('只在勾了「仅未读」时才带 unreadOnly', () => {
    expect(hitEventQuery({ unreadOnly: false })).toBe('')
    expect(hitEventQuery({ unreadOnly: true })).toBe('unreadOnly=true')
  })

  it('翻页带上游标，游标 0 也要带（它是合法的起点）', () => {
    expect(hitEventQuery({ beforeId: 42 })).toBe('beforeId=42')
    expect(hitEventQuery({ beforeId: 0 })).toBe('beforeId=0')
  })

  it('limit 也进查询串', () => {
    expect(hitEventQuery({ limit: 20 })).toBe('limit=20')
  })
})

describe('通知结果文案', () => {
  it('没发过就是没发过', () => {
    expect(notifiedText({})).toBe('未通知')
  })

  it('发成功说通道名', () => {
    expect(notifiedText({ desktop: 'ok' })).toBe('已通知：桌面通知')
  })

  it('失败要把原因说出来，否则用户只知道「没通知」', () => {
    expect(notifiedText({ webhook: 'fail: 网络不通' })).toBe('IM 机器人发送失败：网络不通')
  })

  it('静音跳过要说明是静音，不是失败', () => {
    expect(notifiedText({ desktop: 'skip: 静音时段' })).toBe('桌面通知：静音时段跳过')
  })

  it('多个通道一起说', () => {
    expect(notifiedText({ desktop: 'ok', webhook: 'fail: 404' })).toBe('已通知：桌面通知；IM 机器人发送失败：404')
  })
})

/**
 * Seam：处置状态（告警确认闭环）。
 *
 * 库里的 disposition 只有「待确认 / 已确认」两档，「未确认超时」是按时间推的
 * 第三种显示态 —— 它随时钟走，落库只会过期，所以这层推算必须是纯函数、好钉。
 */
describe('处置状态推算', () => {
  const T0 = new Date('2026-10-05T10:00:00').getTime()

  it('已确认的永远算已确认，再旧也不算超时', () => {
    expect(dispositionOf({ disposition: 'acknowledged', ts: '2026-10-05 07:00:00' }, T0)).toBe('acknowledged')
  })

  it('待确认且还没到时限，是待确认', () => {
    expect(dispositionOf({ disposition: 'pending', ts: '2026-10-05 09:59:00' }, T0)).toBe('pending')
  })

  it('待确认且超过时限，算未确认超时', () => {
    expect(dispositionOf({ disposition: 'pending', ts: '2026-10-05 09:50:00' }, T0)).toBe('timeout')
  })

  it('恰好卡在时限上就算超时（到点即超）', () => {
    // 按本地时间拼 ts：引擎写的就是本地时间，用 toISOString 会带上 UTC 偏移
    const d = new Date(T0 - ACK_TIMEOUT_MS)
    const p = (n: number) => String(n).padStart(2, '0')
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    expect(dispositionOf({ disposition: 'pending', ts }, T0)).toBe('timeout')
  })

  it('ts 解析不出来时按待确认算，不许误判成超时', () => {
    expect(dispositionOf({ disposition: 'pending', ts: '' }, T0)).toBe('pending')
    expect(dispositionOf({ disposition: 'pending', ts: '不是时间' }, T0)).toBe('pending')
  })
})

describe('命中时间解析', () => {
  it('认引擎的 `YYYY-MM-DD HH:MM:SS`（本地时间）', () => {
    expect(parseHitTs('2026-10-05 10:00:00')).toBe(new Date('2026-10-05T10:00:00').getTime())
  })

  it('空串给出 NaN，交给调用方决定怎么退', () => {
    expect(Number.isNaN(parseHitTs(''))).toBe(true)
  })
})

/**
 * Seam：悬浮球"待处理"条数。
 *
 * 只数**超时未确认**那一种，别的都不算：刚命中还没到时限的不该催，
 * 已确认的更不能算进"还没人管"。这个数直接决定球上有没有角标、角标是几。
 */
describe('待处理（超时未确认）条数', () => {
  const T0 = new Date('2026-10-05T10:00:00').getTime()

  it('只数超时未确认的，其余一概不算', () => {
    const events = [
      { disposition: 'pending' as const, ts: '2026-10-05 09:50:00' }, // 超时 ✓
      { disposition: 'pending' as const, ts: '2026-10-05 09:59:00' }, // 还没到时限
      { disposition: 'acknowledged' as const, ts: '2026-10-05 09:00:00' }, // 已确认
      { disposition: 'pending' as const, ts: '2026-10-05 09:40:00' }, // 超时 ✓
    ]
    expect(timeoutPendingCount(events, T0)).toBe(2)
  })

  it('空列表是 0，不抛错', () => {
    expect(timeoutPendingCount([], T0)).toBe(0)
  })

  it('时间坏掉的那条按待确认算，不计入超时', () => {
    expect(timeoutPendingCount([{ disposition: 'pending' as const, ts: '' }], T0)).toBe(0)
  })
})
