import { describe, expect, it } from 'vitest'
import { baseName, joinPath, outputPathOf, suggestOutputDir } from './pathPicker'

describe('输出路径派生', () => {
  it('输出文件与原文件同目录_用户不用再找', () => {
    // 原文件在 E:\data\订单.xlsx → 输出 E:\data\订单_物流信息.xlsx
    expect(outputPathOf('E:/data/订单.xlsx', '_物流信息')).toBe('E:/data/订单_物流信息.xlsx')
  })

  it('原文件在根目录时不凭空造目录', () => {
    expect(outputPathOf('订单.xlsx', '_结果')).toBe('订单_结果.xlsx')
  })

  it('没给原文件时返回空串_界面显示「上传后自动生成」而不是一段假路径', () => {
    expect(outputPathOf('', '_结果')).toBe('')
  })

  it('不认识的后缀原样保留_不该把 .xls 改成 .xlsx', () => {
    expect(outputPathOf('a.csv', '_x')).toBe('a_x.csv')
    expect(outputPathOf('a.XLSX', '_x')).toBe('a_x.XLSX')
  })

  it('默认输出目录取自原文件所在目录', () => {
    expect(suggestOutputDir('D:/work/2026/订单.xlsx')).toBe('D:/work/2026')
    expect(suggestOutputDir('订单.xlsx')).toBe('')
  })
})
describe('路径片段辅助', () => {
  it('取文件名_含扩展名', () => {
    expect(baseName('E:/data/2026/订单.xlsx')).toBe('订单.xlsx')
    expect(baseName('订单.xlsx')).toBe('订单.xlsx')
    expect(baseName('')).toBe('')
  })

  it('拼路径时保留原文件用的分隔符_混用会出问题', () => {
    expect(joinPath('E:/data', 'a.xlsx')).toBe('E:/data/a.xlsx')
    // Windows 风格目录必须仍用反斜杠：拼成 E:/data\a.xlsx 有些程序不认
    const win = joinPath('E:\\data', 'a.xlsx')
    expect(win).toContain('\\')
    expect(win.endsWith('a.xlsx')).toBe(true)
    expect(win).not.toContain('/')
  })

  it('目录为空时直接给文件名_不该产出 /a.xlsx', () => {
    expect(joinPath('', 'a.xlsx')).toBe('a.xlsx')
    expect(joinPath('E:/data/', 'a.xlsx')).toBe('E:/data/a.xlsx')
  })

  it('改了输出目录后输出文件名跟着变', () => {
    const src = joinPath('E:/out', baseName('E:/data/订单.xlsx'))
    expect(outputPathOf(src, '_物流信息')).toBe('E:/out/订单_物流信息.xlsx')
  })
})
