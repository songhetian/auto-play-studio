import { describe, expect, it } from 'vitest'
import { buildLogiCsv, logiCsvFileName, LOGI_CSV_HEADER } from './logiQueryCsv'
import type { LogiQueryItem } from '@/lib/api'

/** 构造一条运单结果（只填用到的字段，其余给默认值） */
function item(p: Partial<LogiQueryItem>): LogiQueryItem {
  return {
    no: '',
    company: '',
    status: '',
    signed_at: '',
    trace: '',
    ok: false,
    message: '',
    ...p,
  }
}

describe('buildLogiCsv', () => {
  it('空列表也产出带 BOM 的表头行', () => {
    const csv = buildLogiCsv([])
    expect(csv.charCodeAt(0)).toBe(0xfeff) // BOM
    expect(csv).toContain(LOGI_CSV_HEADER.join(','))
  })

  it('单行：逗号与换行被转义', () => {
    const csv = buildLogiCsv([
      item({ no: 'SF123', company: '顺丰', status: '已签收', trace: '派送中, 请, 等', ok: true, message: '正常' }),
    ])
    // 含半角逗号的轨迹单元格被双引号包住
    expect(csv).toContain('"派送中, 请, 等"')
    expect(csv).toContain('顺丰')
    expect(csv).toContain('是')
  })

  it('是否查成：ok=false 记为"否"', () => {
    const csv = buildLogiCsv([item({ no: 'SF999', ok: false, message: '单号无效' })])
    expect(csv).toContain('否')
    expect(csv).toContain('单号无效')
  })

  it('多行：每条独立一行', () => {
    const csv = buildLogiCsv([item({ no: 'A' }), item({ no: 'B' })])
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n')
    expect(lines).toHaveLength(3) // 表头 + 2 数据
    expect(lines[1]).toContain('A')
    expect(lines[2]).toContain('B')
  })
})

describe('logiCsvFileName', () => {
  it('固定前缀、带时间戳', () => {
    const name = logiCsvFileName(new Date(2026, 9, 8, 13, 5))
    // 没传实例名时 csvFileName 兜底成「实例」
    expect(name).toBe('物流查询-实例-20261008-1305.csv')
  })
})
