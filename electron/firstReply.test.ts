import { describe, expect, it } from 'vitest'
import { FIRST_REPLY_CATEGORY, pickFirstReply, type PhraseLike } from './firstReply'

/**
 * 半自动首响：从话术库里挑出"开新会话要说的第一句话"。
 *
 * 客服开新会话时手忙脚乱，要的就是一句话术立刻能用。挑法必须**确定、可预期**，
 * 不能有随机性 —— 否则客服每次按下去拿到的开场白都不一样，没法形成手感。
 */
function ph(partial: Partial<PhraseLike> & { title: string }): PhraseLike {
  return { body: partial.body ?? '正文', category: partial.category ?? '', usedCount: partial.usedCount ?? 0, ...partial }
}

describe('挑选首响话术', () => {
  it('优先选「首响」分类里用得最多的那条', () => {
    const list = [
      ph({ title: '通用问候', usedCount: 9 }),
      ph({ title: '开场A', category: FIRST_REPLY_CATEGORY, usedCount: 3 }),
      ph({ title: '开场B', category: FIRST_REPLY_CATEGORY, usedCount: 7 }),
    ]
    expect(pickFirstReply(list)).toEqual({ phrase: list[2], reason: 'category' })
  })

  it('首响分类里并列时保持引擎给的顺序（引擎已按常用在前）', () => {
    const list = [
      ph({ title: '开场A', category: FIRST_REPLY_CATEGORY, usedCount: 5 }),
      ph({ title: '开场B', category: FIRST_REPLY_CATEGORY, usedCount: 5 }),
    ]
    expect(pickFirstReply(list)?.phrase.title).toBe('开场A')
  })

  it('分类名两侧有空格也算命中（手输分类常带空格）', () => {
    const list = [ph({ title: '开场', category: ` ${FIRST_REPLY_CATEGORY} `, usedCount: 1 })]
    expect(pickFirstReply(list)?.reason).toBe('category')
  })

  it('没建「首响」分类时退化为用得最多的一条', () => {
    const list = [ph({ title: '少用', usedCount: 2 }), ph({ title: '常用', usedCount: 8 })]
    expect(pickFirstReply(list)).toEqual({ phrase: list[1], reason: 'most-used' })
  })

  it('全都没用过时退化为第一条，并说明原因', () => {
    const list = [ph({ title: '第一条' }), ph({ title: '第二条' })]
    expect(pickFirstReply(list)).toEqual({ phrase: list[0], reason: 'first' })
  })

  it('话术库为空返回 null（调用方据此提示先加一条）', () => {
    expect(pickFirstReply([])).toBeNull()
  })

  it('usedCount 缺失按 0 处理，不会因 NaN 挑错', () => {
    const list = [
      { title: 'a', body: 'x', category: '', usedCount: Number.NaN },
      ph({ title: 'b', usedCount: 1 }),
    ]
    expect(pickFirstReply(list)?.phrase.title).toBe('b')
  })
})

describe('首响分类常量', () => {
  it('分类名固定为「首响」', () => {
    expect(FIRST_REPLY_CATEGORY).toBe('首响')
  })
})