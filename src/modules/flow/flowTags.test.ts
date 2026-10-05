import { describe, expect, it } from 'vitest'
import { parseTags } from './flowTags'

/**
 * 分类标签的输入解析（界面上「多个用逗号分隔」）。
 *
 * 之前这段是内联在 onBlur 里的，随手改分隔符就没法验证；抽成纯函数后
 * 「顿号/逗号/空格都认、连续分隔不产生空标签」这条口径才算被钉住。
 */
describe('parseTags', () => {
  it('逗号、顿号、空格都当分隔符', () => {
    expect(parseTags('售后,物流')).toEqual(['售后', '物流'])
    expect(parseTags('售后、物流')).toEqual(['售后', '物流'])
    expect(parseTags('售后 物流')).toEqual(['售后', '物流'])
    expect(parseTags('售后，物流')).toEqual(['售后', '物流'])
  })

  it('去首尾空白', () => {
    expect(parseTags(' 售后 ， 物流 ')).toEqual(['售后', '物流'])
  })

  it('连续分隔符不产生空标签', () => {
    expect(parseTags('售后、、物流')).toEqual(['售后', '物流'])
    expect(parseTags('售后, ,物流')).toEqual(['售后', '物流'])
  })

  it('空输入得到空列表（不是 [""]）', () => {
    expect(parseTags('')).toEqual([])
    expect(parseTags('   ')).toEqual([])
    expect(parseTags('、,，')).toEqual([])
  })

  it('单个标签原样保留', () => {
    expect(parseTags('售后')).toEqual(['售后'])
  })
})
