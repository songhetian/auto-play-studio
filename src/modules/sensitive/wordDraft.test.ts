import { describe, expect, it } from 'vitest'
import { draftToWordInput } from '@/modules/sensitive/wordDraft'

describe('draftToWordInput', () => {
  it('拼音键转成引擎认的 match_key，而不是原样带 matchKey', () => {
    const out = draftToWordInput({ word: '退款政策', level: 'high', matchKey: 'tkzc', note: '' })

    expect(out.match_key).toBe('tkzc')
    expect((out as unknown as Record<string, unknown>).matchKey).toBeUndefined()
  })

  it('逐字段映射，取值不改动', () => {
    const out = draftToWordInput({ word: '加微信', level: 'mid', matchKey: '', note: '备注' })

    expect(out).toEqual({ word: '加微信', level: 'mid', match_key: '', note: '备注' })
  })
})
