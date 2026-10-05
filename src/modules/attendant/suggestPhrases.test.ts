import { describe, expect, it } from 'vitest'
import type { Phrase } from '@/modules/phrases/usePhrases'
import { SUGGEST_LIMIT, SUGGEST_MIN_SCORE, suggestPhrases } from './suggestPhrases'

/**
 * 选区自动建议的排序逻辑。
 *
 * 输入是"客服框住的那句客户消息"，输出是可能用得上的话术。
 * 关键取舍：**不能把整句当查询词**（那样一条也匹配不上），
 * 而是拆成 2~4 字的连续片段去话术里找 —— 这些片段命中的字数越多越相关。
 * 命中位置也有轻重：标题 > 分类 > 正文（客服先看标题认那句说辞）。
 */
function ph(partial: Partial<Phrase> & { id: number; title: string }): Phrase {
  return {
    body: '',
    category: '',
    usedCount: 0,
    createdAt: '',
    updatedAt: '',
    ...partial,
  } as Phrase
}

describe('选区建议排序', () => {
  const corpus = [
    ph({ id: 1, title: '退款流程', body: '您好，退款需要走售后入口' }),
    ph({ id: 2, title: '发货时效', body: '一般 48 小时内发货，节假日顺延' }),
    ph({ id: 3, title: '问候语', body: '您好，很高兴为您服务' }),
  ]

  it('按消息内容挑出相关话术：问发货就推发货那条', () => {
    const got = suggestPhrases('我的订单什么时候发货', corpus)
    expect(got.map((p) => p.id)).toContain(2)
  })

  it('标题命中权重高于正文：只有正文沾边的进不了建议', () => {
    const list = [
      ph({ id: 1, title: '退款说明', body: '说明' }),
      ph({ id: 2, title: '其他', body: '退款说明' }),
    ]
    const got = suggestPhrases('退款', list)
    expect(got.map((p) => p.id)).toEqual([1])
  })

  it('完全无关的话术不会被硬塞进来', () => {
    const list = [ph({ id: 1, title: '积分规则', body: '积分每月月底清零' })]
    expect(suggestPhrases('我要退货', list)).toEqual([])
  })

  it('相关度高的排前面', () => {
    const list = [
      ph({ id: 1, title: '物流查询', body: '发货后可在订单里查物流' }),
      ph({ id: 2, title: '发货时效', body: '发货时间说明' }),
    ]
    const got = suggestPhrases('什么时候发货', list)
    expect(got[0].id).toBe(2)
  })

  it('空消息或空话术库返回空数组', () => {
    expect(suggestPhrases('', corpus)).toEqual([])
    expect(suggestPhrases('发货', [])).toEqual([])
    expect(suggestPhrases('   ', corpus)).toEqual([])
  })

  it('最多返回 limit 条', () => {
    const many = Array.from({ length: 30 }, (_, i) => ph({ id: i + 1, title: `发货说明${i}`, body: '发货' }))
    expect(suggestPhrases('发货', many).length).toBeLessThanOrEqual(SUGGEST_LIMIT)
  })

  it('相关度不足的弱命中会被阈值挡掉（正文蹭到两个字不够）', () => {
    const list = [ph({ id: 1, title: 'x', body: '退款' })]
    // 正文权重 1 × 命中 2 字 = 2，低于阈值
    expect(suggestPhrases('退款', list)).toEqual([])
    expect(SUGGEST_MIN_SCORE).toBeGreaterThan(2)
  })

  it('同分时保持话术库给的原顺序（引擎已按常用在前）', () => {
    const list = [ph({ id: 1, title: '发货A' }), ph({ id: 2, title: '发货B' })]
    const got = suggestPhrases('发货', list)
    expect(got.map((p) => p.id)).toEqual([1, 2])
  })
})