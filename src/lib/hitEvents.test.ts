import { describe, it, expect } from 'vitest'
import { hitEventQuery, notifiedText } from './hitEvents'

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
