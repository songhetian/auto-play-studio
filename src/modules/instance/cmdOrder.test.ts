import { describe, expect, it } from 'vitest'
import { moveAt, remapIndex } from './cmdOrder'

/**
 * 指令序列拖拽重排。
 *
 * 之前选中项存的是**下标**，拖完还拿着旧下标 —— 右侧属性面板（以及以 cmdIndex
 * 为 key 的 KeyPicker）会指向另一条指令：用户以为在改 A，其实在改 B。
 *
 * 修法不是给 Cmd 加 id（那是持久化结构，老存档没有），
 * 而是重排后把下标**跟着它原来指的那条指令走**。
 */

/** [A,B,C,D] 把 A(0) 拖到 2 → [B,C,A,D] */
const ABCD = ['A', 'B', 'C', 'D']

describe('remapIndex', () => {
  it('没选中就还是没选中', () => {
    expect(remapIndex(-1, 0, 2)).toBe(-1)
  })

  it('选中的就是被拖的那条 → 跟到新位置', () => {
    // [A,B,C,D] 拖 A 到 2 → A 落在下标 2
    expect(remapIndex(0, 0, 2)).toBe(2)
    expect(remapIndex(3, 3, 1)).toBe(1)
  })

  it('向下拖：夹在中间的那几条各前移一位', () => {
    // [A,B,C,D] 拖 A(0) 到 2 → B、C 各前移一位
    expect(remapIndex(1, 0, 2)).toBe(0)
    expect(remapIndex(2, 0, 2)).toBe(1)
  })

  it('向下拖：拖点之后的选中项不动', () => {
    expect(remapIndex(3, 0, 2)).toBe(3)
  })

  it('向上拖：夹在中间的那几条各后移一位', () => {
    // [A,B,C,D] 拖 D(3) 到 1 → B、C 各后移一位
    expect(remapIndex(2, 3, 1)).toBe(3)
    expect(remapIndex(1, 3, 1)).toBe(2)
  })

  it('向上拖：拖点之前的选中项不动', () => {
    expect(remapIndex(0, 3, 1)).toBe(0)
  })

  it('原地不动时选中项不变', () => {
    expect(remapIndex(2, 2, 2)).toBe(2)
  })
})

describe('moveAt', () => {
  it('把 from 移到 to 的位置', () => {
    expect(moveAt(ABCD, 0, 2)).toEqual(['B', 'C', 'A', 'D'])
    expect(moveAt(ABCD, 3, 1)).toEqual(['A', 'D', 'B', 'C'])
    expect(moveAt(ABCD, 1, 2)).toEqual(['A', 'C', 'B', 'D'])
  })

  it('不改原数组', () => {
    const src = [...ABCD]
    moveAt(src, 0, 3)
    expect(src).toEqual(ABCD)
  })

  it('from 越界或与 to 相同就原样返回', () => {
    expect(moveAt(ABCD, -1, 2)).toEqual(ABCD)
    expect(moveAt(ABCD, 9, 2)).toEqual(ABCD)
    expect(moveAt(ABCD, 1, 1)).toEqual(ABCD)
  })

  it('空列表不炸', () => {
    expect(moveAt([], 0, 1)).toEqual([])
  })
})
