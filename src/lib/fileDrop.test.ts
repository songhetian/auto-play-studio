import { describe, expect, it } from 'vitest'
import { filterFiles, describeFiles, formatSize } from './fileDrop'

/**
 * 文件拖拽 / 多文件选择的行为规格。
 *
 * 现状问题（用户反馈「文件上传都要支持拖拽，并且支持多文件」）：
 *  1. 现有 Dropzone 只取 `files[0]` —— 拖 5 个进来只处理 1 个，且另外 4 个**静默消失**
 *  2. 扩展名不符时 `return` 掉，用户**看不到任何提示**，只觉得"拖了没反应"
 *  3. 没有多选（input 没加 multiple）
 *
 * 规格：
 *  - 多文件：一次接受多个，按 accept 过滤
 *  - 被拒的文件必须**逐个列出原因**，不能静默丢
 *  - 大小限制要说清
 */
describe('拖拽上传的文件筛选', () => {
  const f = (name: string, size = 1024) => ({ name, size } as File)

  it('接受多个文件_不再只取第一个', () => {
    const r = filterFiles([f('a.xlsx'), f('b.xlsx'), f('c.xlsx')], '.xlsx,.xls')
    expect(r.accepted.map((x) => x.name)).toEqual(['a.xlsx', 'b.xlsx', 'c.xlsx'])
    expect(r.rejected).toEqual([])
  })

  it('按扩展名过滤_允许多种', () => {
    const r = filterFiles([f('a.xlsx'), f('b.pdf'), f('c.csv')], '.xlsx,.csv')
    expect(r.accepted.map((x) => x.name)).toEqual(['a.xlsx', 'c.csv'])
  })

  it('被拒的文件逐个列出原因_不能静默丢', () => {
    const r = filterFiles([f('a.xlsx'), f('b.pdf'), f('c.txt')], '.xlsx')
    expect(r.accepted).toHaveLength(1)
    expect(r.rejected.map((x) => x.name)).toEqual(['b.pdf', 'c.txt'])
    // 原因里要说清"只收什么"，用户才知道该改后缀还是换文件
    for (const x of r.rejected) expect(x.reason).toContain('格式')
  })

  it('超大的文件要说清原因_而不是直接忽略', () => {
    const r = filterFiles([f('big.xlsx', 20 * 1024 * 1024)], '.xlsx', 10 * 1024 * 1024)
    expect(r.accepted).toEqual([])
    expect(r.rejected[0].reason).toContain('大小')
  })

  it('扩展名大小写不敏感_.XLSX 也是 Excel', () => {
    const r = filterFiles([f('A.XLSX')], '.xlsx')
    expect(r.accepted).toHaveLength(1)
  })

  it('扩展名只看最后一段_不会把 a.xlsx.bak 当成 Excel', () => {
    const r = filterFiles([f('a.xlsx.bak')], '.xlsx')
    expect(r.accepted).toEqual([])
    expect(r.rejected).toHaveLength(1)
  })

  it('没有扩展名的文件被拒_并说明原因', () => {
    const r = filterFiles([f('无扩展名')], '.xlsx')
    expect(r.accepted).toEqual([])
    expect(r.rejected[0].reason).toBeTruthy()
  })

  it('一个都没通过时要给出总结性提示', () => {
    const r = filterFiles([f('a.pdf')], '.xlsx')
    expect(r.accepted).toEqual([])
    expect(r.rejected).toHaveLength(1)
  })

  it('大小可读化_用户能看懂多大', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('描述汇总_一句话说清"收下了几个、退回了几个"', () => {
    const r = filterFiles([f('a.xlsx'), f('b.pdf')], '.xlsx')
    expect(describeFiles(r)).toContain('1 个')
    expect(describeFiles(r)).toContain('b.pdf')
  })

  it('空选择不报错_用户取消选择是正常操作', () => {
    const r = filterFiles([], '.xlsx')
    expect(r.accepted).toEqual([])
    expect(r.rejected).toEqual([])
  })
})
