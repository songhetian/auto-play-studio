import { describe, expect, it } from 'vitest'
import { parseSelection } from './parseSelection'

/**
 * 选区解析（工单 04 · ②③）：把客服框住的那段客户消息，一次性解析出
 * 单号 / 人名 / 订单号 / 日期，供「一键查件」与「变量自动填」两处复用。
 *
 * 之前两处各扫一遍选区、两套正则会互相打架；现在合成一个函数。
 * 期望值手写；启发式（人名 2-3 字、订单号跟在「订单」后）的边界也测了。
 */
describe('单号', () => {
  it('复用 parseWaybills 的识别', () => {
    const r = parseSelection('SF1234567890 和 YT9876543210 都在路上')
    expect(r.waybills).toEqual(['SF1234567890', 'YT9876543210'])
  })
  it('去重、忽略空白', () => {
    const r = parseSelection('  SF001 \n\n SF001 \nYT002\n')
    expect(r.waybills).toEqual(['SF001', 'YT002'])
  })
})

describe('人名', () => {
  it('取被非中文包围的 2-3 字中文（聊天里常见形态）', () => {
    const r = parseSelection('亲，张三的订单号 NO2026ABC，请查收')
    expect(r.names).toEqual(['张三'])
  })
  it('常见称呼 / 礼貌词不当成人名', () => {
    const r = parseSelection('您好，客户先生，订单已发')
    expect(r.names).toEqual([])
  })
  it('没像人名的就返回空', () => {
    const r = parseSelection('订单号 NO2026ABC 已发货')
    expect(r.names).toEqual([])
  })
})

describe('订单号', () => {
  it('跟在「订单号 / 单号」后的字母数字串', () => {
    const r = parseSelection('您的订单号 NO2026ABC 已付款')
    expect(r.orderNos).toEqual(['NO2026ABC'])
  })
  it('没有「订单」引导词时不误抓普通单号当订单号', () => {
    const r = parseSelection('SF1234567890 已揽收')
    expect(r.orderNos).toEqual([])
  })
})

describe('日期', () => {
  it('识别 YYYY-MM-DD 与 YYYY/MM/DD', () => {
    const r = parseSelection('预计 2026-10-08 或 2026/10/09 送达')
    expect(r.dates).toEqual(['2026-10-08', '2026-10-09'])
  })
})

describe('综合', () => {
  it('一段真实客户消息能同时给出三类', () => {
    const r = parseSelection('亲，张三的订单号 NO2026ABC，单号 SF1234567890，预计 2026-10-08 到')
    expect(r.names).toEqual(['张三'])
    expect(r.orderNos).toEqual(['NO2026ABC'])
    expect(r.waybills).toEqual(['SF1234567890'])
    expect(r.dates).toEqual(['2026-10-08'])
  })
})
