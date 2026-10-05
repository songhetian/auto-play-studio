import { describe, expect, it } from 'vitest'
import { MAX_QUERY_NUMBERS, parseWaybills } from '@/lib/logiInput'

describe('快速查单：粘贴的单号解析', () => {
  it('换行、空格、半角/全角逗号都能当分隔符', () => {
    expect(parseWaybills('SF001\nYT002, ZT003，JD004')).toEqual(['SF001', 'YT002', 'ZT003', 'JD004'])
  })

  it('去掉空白项与重复单号，并保持输入顺序', () => {
    expect(parseWaybills('  SF001 \n\n SF001 \nSF002\n')).toEqual(['SF001', 'SF002'])
  })

  it('空输入得到空清单，不产生空单号', () => {
    expect(parseWaybills('   \n , ，\n')).toEqual([])
  })

  it('单次上限是 20，与后端一致', () => {
    expect(MAX_QUERY_NUMBERS).toBe(20)
  })
})
