import { describe, expect, it } from 'vitest'
import {
  buildViolationCsv,
  VIOLATION_LEVEL_LABEL,
  violationQuery,
  type ViolationEvent,
} from './violationStats'

/**
 * 违规统计页的纯逻辑 seam（工单 04 · ⑤）。
 *
 * 和 hitEvents 一样，最容易出错的是「查询串漏带一个参数筛选就静默失效」与
 * 「导出 CSV 中文乱码 / 半角逗号没转义」。这两块必须好钉、期望值手写。
 */

const ROW: ViolationEvent = {
  id: 1,
  word: '加微信',
  level: 'high',
  seat: 'song',
  instanceId: 'G1',
  tool: 'guard',
  detail: '亲加我微信 abc123',
  ts: '2026-10-05 10:00:00',
}

describe('查询串', () => {
  it('没有筛选时不带任何参数', () => {
    expect(violationQuery({})).toBe('')
  })
  it('空值不进查询串', () => {
    expect(violationQuery({ word: '', level: '', seat: undefined, dateFrom: '', dateTo: '' })).toBe('')
  })
  it('按词筛选', () => {
    expect(decodeURIComponent(violationQuery({ word: '加微信' }))).toBe('word=加微信')
  })
  it('按危级筛选', () => {
    expect(violationQuery({ level: 'high' })).toBe('level=high')
  })
  it('按坐席筛选', () => {
    expect(violationQuery({ seat: 'song' })).toBe('seat=song')
  })
  it('按时间区间筛选', () => {
    expect(violationQuery({ dateFrom: '2026-10-01', dateTo: '2026-10-31' })).toBe(
      'dateFrom=2026-10-01&dateTo=2026-10-31',
    )
  })
  it('多个条件一起带', () => {
    expect(decodeURIComponent(violationQuery({ word: '加微信', level: 'high', limit: 50 }))).toBe(
      'word=加微信&level=high&limit=50',
    )
  })
  it('limit 进查询串', () => {
    expect(violationQuery({ limit: 100 })).toBe('limit=100')
  })
})

describe('危级文案', () => {
  it('三档都认', () => {
    expect(VIOLATION_LEVEL_LABEL.high).toBe('高危')
    expect(VIOLATION_LEVEL_LABEL.mid).toBe('中危')
    expect(VIOLATION_LEVEL_LABEL.low).toBe('低危')
  })
  it('不认识的危级回退原值', () => {
    expect(VIOLATION_LEVEL_LABEL['???'] ?? '???').toBe('???')
  })
})

describe('导出 CSV', () => {
  it('带表头、带 BOM、每行一条事件', () => {
    const csv = buildViolationCsv([ROW])
    expect(csv.startsWith('﻿')).toBe(true) // BOM：没它 Excel 中文乱码
    const lines = csv.replace(/﻿/, '').trim().split('\r\n')
    expect(lines[0]).toBe('时间,违禁词,危级,坐席,实例,上下文')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('加微信')
    expect(lines[1]).toContain('高危')
  })
  it('上下文里的半角逗号要转义（否则会被当成两列）', () => {
    const csv = buildViolationCsv([{ ...ROW, detail: '加我,微信' }])
    const dataLine = csv.replace(/﻿/, '').trim().split('\r\n')[1]
    expect(dataLine).toContain('"加我,微信"')
  })
  it('空列表只输出表头', () => {
    const csv = buildViolationCsv([])
    const lines = csv.replace(/﻿/, '').trim().split('\r\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('时间,违禁词,危级,坐席,实例,上下文')
  })
})
