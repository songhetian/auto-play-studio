import { describe, expect, it } from 'vitest'
import { humanStatus, summarizeRun } from '@/lib/logiStatus'

describe('快速查单：状态人话化与结果摘要', () => {
  it('已签收是完成调，运输途中是在途调', () => {
    expect(humanStatus({ status: '已签收', ok: true }).tone).toBe('ok')
    expect(humanStatus({ status: '运输中', ok: true }).tone).toBe('moving')
    expect(humanStatus({ status: '派送中', ok: true }).tone).toBe('moving')
  })

  it('查无轨迹 / 查无结果是灰调，不吓人', () => {
    expect(humanStatus({ status: '无轨迹', ok: true }).tone).toBe('muted')
    expect(humanStatus({ status: '查无结果', ok: true }).tone).toBe('muted')
  })

  it('查询失败是红调，状态本身就是给人话的原因', () => {
    const s = humanStatus({ status: '待人工验证', ok: false })
    expect(s.tone).toBe('bad')
    expect(s.label).toBe('待人工验证')
  })

  it('摘要区分「查到」与「未查到/失败」', () => {
    const s = summarizeRun([
      { status: '已签收', ok: true },
      { status: '运输中', ok: true },
      { status: '无轨迹', ok: true },
      { status: '查询失败', ok: false },
    ])
    expect(s.total).toBe(4)
    expect(s.ok).toBe(2)
    expect(s.failed).toBe(2)
    expect(s.headline).toContain('2')
  })

  it('全部查到时只说总数', () => {
    expect(summarizeRun([{ status: '已签收', ok: true }]).headline).toBe('全部查到：共 1 条')
  })
})
