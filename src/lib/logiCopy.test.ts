import { describe, expect, it } from 'vitest'
import { toCsv, toTsv, logiCsvName } from '@/lib/logiCopy'

const row = (no: string, company: string, status: string, signed_at: string, trace: string) => ({
  no,
  company,
  status,
  signed_at,
  trace,
})

describe('复制全部：查单结果转 TSV', () => {
  it('第一行是表头，列按 单号/公司/状态/签收时间/轨迹', () => {
    expect(toTsv([])).toBe('单号\t公司\t状态\t签收时间\t轨迹')
  })

  it('每条结果一行，字段用制表符分隔', () => {
    const tsv = toTsv([row('SF001', '顺丰', '已签收', '2026-10-01 10:00', '签收人：本人')])

    expect(tsv.split('\n')).toEqual([
      '单号\t公司\t状态\t签收时间\t轨迹',
      'SF001\t顺丰\t已签收\t2026-10-01 10:00\t签收人：本人',
    ])
  })

  it('轨迹里的换行、制表符压成空格，免得一行被劈断', () => {
    const tsv = toTsv([row('SF001', '顺丰', '运输中', '', '第一行\n第二行\t带制表')])

    expect(tsv.split('\n')).toHaveLength(2)
    expect(tsv).toContain('第一行 第二行 带制表')
  })

  it('缺字段留空，不写出 undefined', () => {
    expect(toTsv([{ no: 'SF001' } as never])).toBe(
      '单号\t公司\t状态\t签收时间\t轨迹\nSF001\t\t\t\t',
    )
  })
})

describe('导出 CSV：查单结果存成文件', () => {
  it('开头带 BOM —— 不带的话 Excel 打开中文全是乱码', () => {
    expect(toCsv([row('SF001', '顺丰', '已签收', '', '')]).startsWith('\uFEFF')).toBe(true)
  })

  it('第一行表头，每条结果一行，行尾用 \\r\\n', () => {
    const csv = toCsv([row('SF001', '顺丰', '已签收', '2026-10-01 10:00', '签收人：本人')]).slice(1)

    expect(csv.split('\r\n')).toEqual([
      '单号,公司,状态,签收时间,轨迹',
      'SF001,顺丰,已签收,2026-10-01 10:00,签收人：本人',
      '',
    ])
  })

  it('轨迹里的半角逗号要转义，否则一行会被劈成两列', () => {
    expect(toCsv([row('SF001', '顺丰', '运输中', '', '已到, 派送中')]).slice(1)).toContain(
      'SF001,顺丰,运输中,,"已到, 派送中"',
    )
  })

  it('全角逗号不是分隔符，不该加引号', () => {
    expect(toCsv([row('SF001', '顺丰', '已签收', '', '签收人，本人')]).slice(1)).toContain(
      'SF001,顺丰,已签收,,签收人，本人',
    )
  })

  it('轨迹里的换行留在格子里而不是另起一行', () => {
    const csv = toCsv([row('SF001', '顺丰', '运输中', '', '第一行\n第二行')]).slice(1)

    expect(csv.split('\r\n')).toHaveLength(3) // 表头 + 一条数据 + 结尾空串
    expect(csv).toContain('"第一行\n第二行"')
  })

  it('没有结果时只有表头，不是空文件', () => {
    expect(toCsv([]).slice(1)).toBe('单号,公司,状态,签收时间,轨迹\r\n')
  })
})

describe('导出 CSV 文件名', () => {
  it('带上实例名与时间，文件多了也认得出是哪一轮', () => {
    expect(logiCsvName('订单回访', new Date(2026, 9, 2, 15, 4))).toBe('物流查询-订单回访-20261002-1504.csv')
  })

  it('实例名里的路径字符要换掉，否则另存时会被系统拒绝', () => {
    expect(logiCsvName('订单/回访:一轮', new Date(2026, 9, 2, 15, 4))).toBe('物流查询-订单_回访_一轮-20261002-1504.csv')
  })

  it('实例名空白时退回到一个能用的名字', () => {
    expect(logiCsvName('   ', new Date(2026, 9, 2, 15, 4))).toBe('物流查询-实例-20261002-1504.csv')
  })
})
