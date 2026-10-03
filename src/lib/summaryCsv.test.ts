import { describe, expect, it } from 'vitest'
import { pendingCsv, pendingFileName } from '@/lib/summaryCsv'
import type { PendingRow } from '@/lib/api'

const row = (n: number, key: string, reason: string): PendingRow => ({ row: n, key, reason })

describe('待人工确认清单导出', () => {
  it('开头带 BOM —— 不带的话 Excel 打开中文全是乱码', () => {
    expect(pendingCsv([row(3, 'A002', '找不到窗口')]).startsWith('\uFEFF')).toBe(true)
  })

  it('每条失败一行，行号在最前面', () => {
    const csv = pendingCsv([row(3, 'A002', '找不到窗口'), row(7, 'A006', '无轨迹')])

    expect(csv.slice(1).split('\r\n')).toEqual(['行号,主键,失败原因', '3,A002,找不到窗口', '7,A006,无轨迹', ''])
  })

  it('原因里的半角逗号要转义，否则一行会被劈成两列', () => {
    expect(pendingCsv([row(3, 'A002', '打不开, 请检查')]).slice(1)).toContain('3,A002,"打不开, 请检查"')
  })

  it('全角逗号不是分隔符，不该加引号', () => {
    // 中文文案里的「，」占绝大多数；把它一起加引号，导出的表里会到处是多余的引号
    expect(pendingCsv([row(3, 'A002', '打不开，请检查')]).slice(1)).toContain('3,A002,打不开，请检查')
  })

  it('原因里的引号按 CSV 规则翻倍，并整格加引号', () => {
    expect(pendingCsv([row(3, 'A002', '说「A"B」')]).slice(1)).toContain('"说「A""B」"')
  })

  it('原因里的换行留在格子里而不是另起一行', () => {
    const csv = pendingCsv([row(3, 'A002', '第一行\n第二行')]).slice(1)

    expect(csv.split('\r\n')).toHaveLength(3) // 表头 + 一条数据 + 结尾空串
    expect(csv).toContain('"第一行\n第二行"')
  })

  it('没有失败时只有表头，不是空文件', () => {
    expect(pendingCsv([]).slice(1)).toBe('行号,主键,失败原因\r\n')
  })
})

describe('导出文件名', () => {
  it('带上实例名与时间，文件多了也认得出是哪一轮', () => {
    expect(pendingFileName('订单回访', new Date(2026, 9, 2, 15, 4))).toBe('待人工确认-订单回访-20261002-1504.csv')
  })

  it('实例名里的路径字符要换掉，否则另存时会被系统拒绝', () => {
    expect(pendingFileName('订单/回访:一轮', new Date(2026, 9, 2, 15, 4))).toBe('待人工确认-订单_回访_一轮-20261002-1504.csv')
  })

  it('实例名全是非法字符时退回到一个能用的名字', () => {
    expect(pendingFileName('   ', new Date(2026, 9, 2, 15, 4))).toBe('待人工确认-实例-20261002-1504.csv')
  })
})
