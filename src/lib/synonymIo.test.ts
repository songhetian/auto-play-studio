import { describe, expect, it } from 'vitest'
import { defaultSynonymFilename, parseGroups, serializeGroups } from './synonymIo'

describe('同义词表 JSON 序列化/解析', () => {
  it('序列化再解析可回环，且不改变归一化后的形状', () => {
    const groups: string[][] = [['螺丝', '螺栓', '螺钉']]
    const round = parseGroups(serializeGroups(groups))
    expect(round).toEqual(groups)
  })

  it('解析带 groups 字段的对象信封', () => {
    const text = JSON.stringify({ schemaVersion: 1, groups: [['插头', '插销']] })
    expect(parseGroups(text)).toEqual([['插头', '插销']])
  })

  it('也接受裸的二维字符串数组', () => {
    const text = JSON.stringify([['垫圈', '密封圈']])
    expect(parseGroups(text)).toEqual([['垫圈', '密封圈']])
  })

  it('归一化：去空格、去空词、组内去重、丢弃空组', () => {
    const text = JSON.stringify({
      groups: [
        [' 螺丝 ', '螺栓', '螺丝', ''],
        [],
        ['   '],
      ],
    })
    expect(parseGroups(text)).toEqual([['螺丝', '螺栓']])
  })

  it('顶层既不是数组也不是含 groups 的对象时抛清晰错误', () => {
    expect(() => parseGroups(JSON.stringify({ foo: 1 }))).toThrow(/groups/)
    expect(() => parseGroups(JSON.stringify('螺丝'))).toThrow()
  })

  it('组里有非字符串元素时抛清晰错误', () => {
    const text = JSON.stringify({ groups: [['螺丝', 123]] })
    expect(() => parseGroups(text)).toThrow(/字符串/)
  })
})

describe('默认导出文件名', () => {
  it('用本地日期而不是 UTC —— 凌晨导出时 UTC 会差一天', () => {
    // 本地 2026-10-05 00:30（UTC+8）→ UTC 还是 10-04
    expect(defaultSynonymFilename(new Date(2026, 9, 5, 0, 30))).toBe('synonyms-2026-10-05.json')
  })
})
