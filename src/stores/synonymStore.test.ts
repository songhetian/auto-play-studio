import { beforeEach, describe, expect, it } from 'vitest'
import { buildSynonymMap, locateByIntent, type IntentItem } from '@/lib/intentLocate'
import { useSynonymStore } from '@/stores/synonymStore'

const DEFAULT = [['螺丝', '螺栓', '螺钉']]

describe('同义词 store（可自定义）', () => {
  beforeEach(() => useSynonymStore.getState().reset())

  it('默认含内置同义词组', () => {
    expect(useSynonymStore.getState().groups).toEqual(DEFAULT)
  })

  it('addGroup 追加一组', () => {
    useSynonymStore.getState().addGroup(['插头', '插销'])
    expect(useSynonymStore.getState().groups).toEqual([...DEFAULT, ['插头', '插销']])
  })

  it('removeGroup 删除指定组', () => {
    useSynonymStore.getState().addGroup(['插头', '插销'])
    useSynonymStore.getState().removeGroup(0)
    expect(useSynonymStore.getState().groups).toEqual([['插头', '插销']])
  })

  it('addWord 往组里加词并去重', () => {
    useSynonymStore.getState().addWord(0, '螺杆')
    expect(useSynonymStore.getState().groups[0]).toEqual(['螺丝', '螺栓', '螺钉', '螺杆'])
    // 重复词不翻倍
    useSynonymStore.getState().addWord(0, '螺丝')
    expect(useSynonymStore.getState().groups[0]).toEqual(['螺丝', '螺栓', '螺钉', '螺杆'])
  })

  it('removeWord 从组里删词', () => {
    useSynonymStore.getState().removeWord(0, '螺栓')
    expect(useSynonymStore.getState().groups[0]).toEqual(['螺丝', '螺钉'])
  })

  it('越界的组索引操作是安全的空操作', () => {
    const before = useSynonymStore.getState().groups
    useSynonymStore.getState().addWord(99, 'x')
    useSynonymStore.getState().removeGroup(99)
    expect(useSynonymStore.getState().groups).toEqual(before)
  })

  it('reset 回到内置默认', () => {
    useSynonymStore.getState().addGroup(['插头', '插销'])
    useSynonymStore.getState().reset()
    expect(useSynonymStore.getState().groups).toEqual(DEFAULT)
  })

  it('store 的词表能直接喂给 locateByIntent（端到端可用）', () => {
    useSynonymStore.getState().addGroup(['插头', '插销'])
    const map = buildSynonymMap(useSynonymStore.getState().groups)
    const items: IntentItem[] = [{ id: 'a', name: '插销面板' }]
    expect(locateByIntent('插头', items, map).map((h) => h.id)).toEqual(['a'])
  })
})
