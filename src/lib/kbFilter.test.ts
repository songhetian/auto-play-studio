import { describe, expect, it } from 'vitest'
import { findHitRanges, highlightSegments, searchTerms } from '@/lib/kbFilter'

describe('搜索词切分', () => {
  it('按空白切分、去重、统一小写', () => {
    expect(searchTerms('  退款  Policy 退款 ')).toEqual(['退款', 'policy'])
  })

  it('空查询没有词', () => {
    expect(searchTerms('   ')).toEqual([])
    expect(searchTerms('')).toEqual([])
  })
})

describe('命中区间', () => {
  it('大小写不敏感', () => {
    expect(findHitRanges('Refund Policy', ['refund'])).toEqual([{ start: 0, end: 6 }])
  })

  it('同一位置优先取更长的词', () => {
    // 「退」和「退款」都从 0 开始；取长的那个，否则正文里只剩一个「退」被染色
    expect(findHitRanges('退款政策', ['退', '退款'])).toEqual([{ start: 0, end: 2 }])
    expect(findHitRanges('退款政策', ['退款', '退款政策'])).toEqual([{ start: 0, end: 4 }])
  })

  it('区间不重叠：先落位的词不会被后一个词切开', () => {
    // 「款政」从 1 开始，与已占的 0..2 相交 → 丢掉，不做二次切分
    expect(findHitRanges('退款政策', ['退款', '款政'])).toEqual([{ start: 0, end: 2 }])
  })

  it('同一个词出现多次都要标出来', () => {
    // 退款政策：7 天无理由退还 —— 两个「退」分别在第 0 位与第 11 位
    expect(findHitRanges('退款政策：7 天无理由退还', ['退'])).toEqual([
      { start: 0, end: 1 },
      { start: 11, end: 12 },
    ])
  })

  it('没命中就是空数组', () => {
    expect(findHitRanges('物流说明', ['退款'])).toEqual([])
    expect(findHitRanges('物流说明', [])).toEqual([])
    expect(findHitRanges('', ['退款'])).toEqual([])
  })
})

describe('片段切分', () => {
  it('没命中时整段原样返回，不做无意义的切分', () => {
    expect(highlightSegments('物流说明', ['退款'])).toEqual([{ text: '物流说明', hit: false }])
  })

  it('命中在中间 → 前后各留一段', () => {
    expect(highlightSegments('本店退款政策如下', ['退款'])).toEqual([
      { text: '本店', hit: false },
      { text: '退款', hit: true },
      { text: '政策如下', hit: false },
    ])
  })

  it('整段就是命中词 → 只有一段，不留空壳', () => {
    expect(highlightSegments('退款', ['退款'])).toEqual([{ text: '退款', hit: true }])
  })

  it('多个词各自高亮', () => {
    expect(highlightSegments('退款与换货', ['退款', '换货'])).toEqual([
      { text: '退款', hit: true },
      { text: '与', hit: false },
      { text: '换货', hit: true },
    ])
  })

  it('拼回去必须等于原文 —— 用户要能直接复制这一行', () => {
    const text = '本店退款政策：7 天无理由退款，退款不退货'
    const segs = highlightSegments(text, ['退款', '退货'])
    expect(segs.map((s) => s.text).join('')).toBe(text)
    expect(segs.filter((s) => s.hit).length).toBe(4)
  })

  it('空文本得到空数组，而不是一段空片段', () => {
    expect(highlightSegments('', ['退款'])).toEqual([])
  })
})
