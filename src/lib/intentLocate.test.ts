import { describe, expect, it } from 'vitest'
import { buildSynonymMap, intentTerms, locateByIntent, type IntentItem } from './intentLocate'

describe('意图定位（离线启发式）', () => {
  it('意图句拆成检索词：中文 2-gram + 单字 + 英文按词', () => {
    const t = intentTerms('检查是否遗漏配件')
    expect(t).toContain('配件')
    expect(t).toContain('遗漏')
    // 去重：单字兜底不应产生重复
    expect(new Set(t).size).toBe(t.length)
  })

  it('英文意图按词拆', () => {
    expect(intentTerms('refund policy')).toEqual(['refund', 'policy'])
  })

  it('空意图或空素材返回空', () => {
    expect(locateByIntent('', [{ id: 'a', name: 'x' }])).toEqual([])
    expect(locateByIntent('找配件', [])).toEqual([])
  })

  it('按意图命中并排序：召回率高的靠前', () => {
    const items: IntentItem[] = [
      { id: 'a', name: '包装盒', labels: ['配件', '说明书'] },
      { id: 'b', name: '空白帧', tag: '视频帧' },
      { id: 'c', name: '配件特写', labels: ['配件'] },
    ]
    const hits = locateByIntent('检查是否遗漏配件', items)
    const ids = hits.map((h) => h.id)
    expect(ids).toContain('a')
    expect(ids).toContain('c')
    expect(ids).not.toContain('b') // 没有任何线索命中
    // a 命中「配件」+「说明书」比 c 只命中「配件」召回更高 → 靠前
    expect(hits[0].id).toBe('a')
    expect(hits[0].matched).toContain('配件')
    // 分数在 0~1
    expect(hits[0].score).toBeGreaterThan(0)
    expect(hits[0].score).toBeLessThanOrEqual(1)
  })

  it('标签/OCR 都能参与匹配', () => {
    const items: IntentItem[] = [{ id: 'x', ocr: 'REFUND POLICY APPLIED' }]
    const hits = locateByIntent('refund policy', items)
    expect(hits.map((h) => h.id)).toEqual(['x'])
  })

  it('同义词也能命中：意图"螺丝"能定位到名为"螺栓"的素材', () => {
    const items: IntentItem[] = [
      { id: 'a', name: '螺栓安装位' },
      { id: 'b', name: '垫片' },
    ]
    const hits = locateByIntent('螺丝', items)
    expect(hits.map((h) => h.id)).toEqual(['a'])
    // 借同义词命中，仍按原意图词报告"为什么相关"
    expect(hits[0].matched).toContain('螺丝')
  })

  it('同义词对称且传递：螺栓↔螺丝、螺钉也能命中螺栓', () => {
    const items: IntentItem[] = [
      { id: 'x', name: '螺丝盒' },
      { id: 'y', tag: '螺栓' },
    ]
    // 反向：意图"螺栓"应能定位名为"螺丝"的素材（不是单向映射）
    expect(locateByIntent('螺栓', items).map((h) => h.id)).toContain('x')
    // 传递：第三成员"螺钉"也应命中标签为"螺栓"的素材（证明是按组展开，而非 1:1）
    const byScrew = locateByIntent('螺钉', items)
    expect(byScrew.map((h) => h.id)).toContain('y')
    expect(byScrew[0].matched).toContain('螺钉')
  })

  it('同义词不污染召回率分母、也不误召回无关素材', () => {
    const items: IntentItem[] = [
      { id: 'a', name: '螺栓' },
      { id: 'b', name: '垫片密封' }, // 与螺丝无关
    ]
    const hits = locateByIntent('螺丝', items)
    expect(hits.map((h) => h.id)).toEqual(['a']) // 垫片不被同义词误召回
    // 分母仍是原意图词数（螺丝/螺/丝 = 3），不应因同义词翻倍
    expect(hits[0].score).toBeGreaterThan(0)
    expect(hits[0].score).toBeLessThanOrEqual(1)
  })

  it('buildSynonymMap 把同义词组转成双向查表', () => {
    const map = buildSynonymMap([['插头', '插销']])
    expect(map.get('插头')).toEqual(['插头', '插销'])
    expect(map.get('插销')).toEqual(['插头', '插销'])
  })

  it('locateByIntent 接受自定义同义词表、且与内置表隔离', () => {
    const custom = buildSynonymMap([['插头', '插销']])
    const items: IntentItem[] = [
      { id: 'a', name: '插销面板' },
      { id: 'b', name: '螺栓' }, // 内置「螺丝」组不在自定义表里 → 不应被「插头」命中
    ]
    const hits = locateByIntent('插头', items, custom)
    expect(hits.map((h) => h.id)).toEqual(['a'])
    // 命中靠自定义同义词，且仍按原意图词报告「为什么相关」
    expect(hits[0].matched).toContain('插头')
  })
})
