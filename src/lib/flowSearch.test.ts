import { describe, expect, it } from 'vitest'
import { filterFlows, flowCategories, sortFlows } from './flowSearch'
import type { Flow } from './flowSearch'

const flow = (over: Partial<Flow> = {}): Flow => ({
  id: 'f1',
  name: '退款处理方案',
  tags: ['售后'],
  steps: [
    { id: 's1', title: '接收退款申请', desc: '在客服系统打开退款页，粘贴订单号' },
    { id: 's2', title: '核对物流', desc: '确认买家已寄回' },
  ],
  ...over,
})

const MANY: Flow[] = [
  flow(),
  flow({ id: 'f2', name: '发货跟进方案', tags: ['物流'], steps: [{ id: 's1', title: '打单', desc: '' }] }),
  flow({ id: 'f3', name: '投诉处理方案', tags: ['投诉'], steps: [{ id: 's1', title: '受理', desc: '安抚客户' }] }),
]

describe('flowCategories', () => {
  it('汇总所有方案的标签，去重且不混入空串', () => {
    // 空标签是"没填分类"，当成一个分类会让筛选栏出现一个空按钮
    expect(flowCategories([...MANY, flow({ id: 'f4', tags: ['', '售后'] })])).toEqual(['售后', '物流', '投诉'])
  })

  it('没有方案时返回空数组，不返回 undefined', () => {
    expect(flowCategories([])).toEqual([])
  })
})

describe('filterFlows', () => {
  it('空查询与全部分类原样返回', () => {
    expect(filterFlows(MANY, '', '')).toHaveLength(3)
  })

  it('按方案名匹配', () => {
    expect(filterFlows(MANY, '退款', '').map((f) => f.id)).toEqual(['f1'])
  })

  it('按标签匹配', () => {
    expect(filterFlows(MANY, '', '物流').map((f) => f.id)).toEqual(['f2'])
  })

  it('按步骤标题/说明匹配——找方案时想不起名字，只记得步骤内容', () => {
    expect(filterFlows(MANY, '安抚客户', '').map((f) => f.id)).toEqual(['f3'])
    expect(filterFlows(MANY, '打单', '').map((f) => f.id)).toEqual(['f2'])
  })

  it('多个词按 AND：都命中才保留', () => {
    expect(filterFlows(MANY, '退款 物流', '').map((f) => f.id)).toEqual(['f1'])
  })

  it('搜不到时返回空数组，页面据此显示空态', () => {
    expect(filterFlows(MANY, '不存在的词', '')).toEqual([])
  })
})

describe('sortFlows', () => {
  const base: Flow[] = [
    flow({ id: 'a', name: '甲', tags: ['售后'], steps: [{ id: '1', title: 'a', desc: '' }, { id: '2', title: 'b', desc: '' }] }),
    flow({ id: 'b', name: '乙', tags: ['物流'], steps: [{ id: '1', title: 'a', desc: '' }] }),
    flow({ id: 'c', name: '丙', tags: ['售后'], steps: [{ id: '1', title: 'a', desc: '' }] }),
  ]

  it('按最近编辑：新的在前', () => {
    const list = [
      flow({ id: 'old', updatedAt: '2026-09-01T10:00:00' }),
      flow({ id: 'new', updatedAt: '2026-10-05T10:00:00' }),
    ]
    expect(sortFlows(list, 'recent').map((f) => f.id)).toEqual(['new', 'old'])
  })

  it('按步骤数：多的在前', () => {
    expect(sortFlows(base, 'steps').map((f) => f.id)).toEqual(['a', 'b', 'c'])
  })

  // 中文按拼音序：丙(bǐng) < 甲(jiǎ) < 乙(yǐ)
  it('按名称：中文按拼音排序', () => {
    expect(sortFlows(base, 'name').map((f) => f.id)).toEqual(['c', 'a', 'b'])
  })

  it('没有 updatedAt 的排最后，别让"从未编辑"占据最前', () => {
    const list = [flow({ id: 'none' }), flow({ id: 'some', updatedAt: '2026-10-05T10:00:00' })]
    expect(sortFlows(list, 'recent').map((f) => f.id)).toEqual(['some', 'none'])
  })

  it('排序不改动原数组', () => {
    const before = base.map((f) => f.id)
    sortFlows(base, 'name')
    expect(base.map((f) => f.id)).toEqual(before)
  })
})

describe('分类筛选', () => {
  it('标签首尾空白也容错，与 flowCategories 口径一致', () => {
    // flowCategories 入集合前会对标签 trim，筛选也必须用同一口径；
    // 否则筛选栏显示了「售后」，点它却把这条带空白的方案筛没了
    expect(filterFlows([flow({ tags: [' 售后 '] })], '', '售后')).toHaveLength(1)
  })
})
