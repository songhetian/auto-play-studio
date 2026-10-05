import { describe, expect, it } from 'vitest'
import type { Phrase } from '@/modules/phrases/usePhrases'
import {
  buildInsertText,
  matchRanges,
  phraseVariables,
  scorePhrase,
  searchPhrases,
  splitQuery,
} from './phraseSearch'

/**
 * 话术速查的本地搜索排序 + 插入文本构造。
 *
 * 行为规格（对齐客服按热键那一刻的预期）：
 *  - 空查询：保持引擎给的"常用在前"顺序，不重排；
 *  - 关键词：标题命中 > 分类命中 > 正文命中，位置越靠前越相关；
 *  - 多关键词按 AND；常用度只在打平时做二次键（不能盖过相关性）；
 *  - 插入文本：保留 {变量} 占位符、去掉首尾空白、行尾统一 \n。
 */
function mk(partial: Partial<Phrase> & { id: number; title: string; body: string }): Phrase {
  return {
    category: '',
    usedCount: 0,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    ...partial,
  }
}

const PHRASES: Phrase[] = [
  mk({ id: 1, title: '退款流程', body: '亲，退款会在 3-5 个工作日到账', category: '售后', usedCount: 50 }),
  mk({ id: 2, title: '催发货', body: '亲，我们正在加急为您安排发货', category: '物流', usedCount: 30 }),
  mk({ id: 3, title: '修改地址', body: '请提供新的收货地址，我帮您修改', category: '物流', usedCount: 10 }),
]

describe('splitQuery', () => {
  it('按空白切词并去掉空段', () => {
    expect(splitQuery('退款 流程')).toEqual(['退款', '流程'])
    expect(splitQuery('   ')).toEqual([])
    expect(splitQuery('')).toEqual([])
  })
})

describe('searchPhrases 空查询', () => {
  it('不做筛选、保持原顺序（引擎的"常用在前"）', () => {
    expect(searchPhrases(PHRASES, '').map((p) => p.id)).toEqual([1, 2, 3])
  })

  it('limit 截断', () => {
    expect(searchPhrases(PHRASES, '', 2).map((p) => p.id)).toEqual([1, 2])
  })
})

describe('searchPhrases 关键词', () => {
  it('标题命中排在正文命中之前', () => {
    // "物流" 命中 2/3 的分类；"发货" 里 2 的标题和正文都有
    const r = searchPhrases(PHRASES, '发货')
    expect(r[0].id).toBe(2)
  })

  it('正文命中也能搜到（客服记得的是那句说辞）', () => {
    const r = searchPhrases(PHRASES, '加急')
    expect(r.map((p) => p.id)).toEqual([2])
  })

  it('位置更靠前的更相关', () => {
    const a = mk({ id: 10, title: '本月推荐', body: '退款说明，请查收' })
    const b = mk({ id: 11, title: '其他', body: '亲，这里才是退款说明' })
    // b 排在输入前面，但 a 的命中位置更靠前，必须排到前面
    expect(searchPhrases([b, a], '退款')[0].id).toBe(10)
  })

  it('多关键词按 AND：全部命中才留下', () => {
    // "物流" + "地址" 只有 3 同时满足（分类物流 + 正文地址）
    expect(searchPhrases(PHRASES, '物流 地址').map((p) => p.id)).toEqual([3])
    expect(searchPhrases(PHRASES, '物流 退款')).toEqual([])
  })

  it('ASCII 大小写不敏感', () => {
    const p = mk({ id: 20, title: 'VIP 话术', body: '尊敬的 vvip 客户' })
    expect(searchPhrases([p], 'vip').map((x) => x.id)).toEqual([20])
  })

  it('无命中返回空数组', () => {
    expect(searchPhrases(PHRASES, '不存在的词')).toEqual([])
  })

  it('常用度只在相关性打平时做二次键，不盖过相关性', () => {
    const rare = mk({ id: 30, title: '冷门说法', body: '关于这个话题' })
    const hot = mk({ id: 31, title: '热门话题', body: '关于话题本身' })
    // 两条都命中"话题"：标题命中（30/31 都在标题）取位置，再比常用度
    const r = searchPhrases([rare, hot], '话题')
    expect(r).toHaveLength(2)

    // 关键：标题命中的冷门（0 次）必须压过正文命中的热门（999 次）
    const titleHit = mk({ id: 40, title: '退款说明', body: '无', usedCount: 0 })
    const bodyHit = mk({ id: 41, title: '其他', body: '这里提到退款', usedCount: 999 })
    expect(searchPhrases([bodyHit, titleHit], '退款')[0].id).toBe(40)
  })
})

describe('scorePhrase', () => {
  it('空 tokens 返回 0（视为不筛）', () => {
    expect(scorePhrase(PHRASES[0], [])).toBe(0)
  })

  it('未命中返回 -1', () => {
    expect(scorePhrase(PHRASES[0], ['不存在'])).toBe(-1)
  })
})

describe('buildInsertText', () => {
  it('保留 {变量} 占位符原样', () => {
    expect(buildInsertText(mk({ id: 1, title: 'x', body: '您好 {客户名}' }))).toBe('您好 {客户名}')
  })

  it('去掉首尾空白', () => {
    expect(buildInsertText(mk({ id: 1, title: 'x', body: '  你好  ' }))).toBe('你好')
  })

  it('行尾统一成 \\n（CRLF 不残留）', () => {
    expect(buildInsertText(mk({ id: 1, title: 'x', body: '第一行\r\n第二行' }))).toBe('第一行\n第二行')
  })

  it('内部换行原样保留（多段话术不能挤成一行）', () => {
    expect(buildInsertText(mk({ id: 1, title: 'x', body: '第一行\n\n第三行' }))).toBe('第一行\n\n第三行')
  })
})

describe('phraseVariables', () => {
  it('列出模板变量（去重）', () => {
    expect(phraseVariables(mk({ id: 1, title: 'x', body: '{客户名} 的订单 {订单号} {客户名}' }))).toEqual([
      '客户名',
      '订单号',
    ])
  })

  it('没有变量时为空', () => {
    expect(phraseVariables(mk({ id: 1, title: 'x', body: '普通话术' }))).toEqual([])
  })
})

describe('matchRanges', () => {
  it('找出命中区间（用于高亮）', () => {
    expect(matchRanges('退款流程说明', '退款')).toEqual([{ start: 0, end: 2 }])
  })

  it('同一关键词多次出现都标出', () => {
    expect(matchRanges('退款退款', '退款')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
  })

  it('多关键词、重叠区间合并', () => {
    expect(matchRanges('abcde', 'abc cde')).toEqual([{ start: 0, end: 5 }])
  })

  it('空查询或空文本返回空', () => {
    expect(matchRanges('abc', '')).toEqual([])
    expect(matchRanges('', 'a')).toEqual([])
  })
})