import { describe, expect, it } from 'vitest'
import { entriesFromDataTransfer, hasFileEntry, rootFoldersFrom } from './folderEntries'

/** 一个最小目录条目：只需要 isDirectory 与 webkitGetAsEntry 的返回形状 */
const dirEntry = (name: string) => ({ isFile: false, isDirectory: true, name, fullPath: `/${name}` })
/** 一个普通文件条目 */
const fileEntry = (name: string) => ({ isFile: true, isDirectory: false, name, fullPath: `/${name}` })

describe('拖进来的是什么', () => {
  it('只取 kind=file 且取得到 entry 的那些', () => {
    const folder = dirEntry('资料库')
    const items = [
      { kind: 'string', webkitGetAsEntry: () => null },
      { kind: 'file', webkitGetAsEntry: () => folder },
      { kind: 'file', webkitGetAsEntry: () => null },
    ]
    expect(entriesFromDataTransfer(items)).toEqual([folder])
  })

  it('浏览器没有 webkitGetAsEntry（Firefox）时返回空列表，由界面回退到选择器', () => {
    expect(entriesFromDataTransfer([{ kind: 'file' }])).toEqual([])
  })

  it('拖进来的是文件时要能说出来（提示改拖文件夹）', () => {
    expect(hasFileEntry([fileEntry('a.csv')])).toBe(true)
    expect(hasFileEntry([dirEntry('资料库'), fileEntry('a.csv')])).toBe(true)
  })

  it('全是文件夹时不算', () => {
    expect(hasFileEntry([dirEntry('资料库')])).toBe(false)
    expect(hasFileEntry([])).toBe(false)
  })
})

/**
 * 「选了文件夹」→ 根文件夹的**绝对路径**。
 *
 * 拖拽拿不到绝对路径（`webkitGetAsEntry().fullPath` 只是 `/资料库` 这种虚拟路径），
 * 真路径只能从 `<input type="file" webkitdirectory>` 的 FileList 反推：
 * 每个 File 带 `webkitRelativePath`（第一段就是所选文件夹名）+ Electron 给的绝对路径。
 */
describe('rootFoldersFrom', () => {
  const f = (absolutePath: string, relativePath: string) => ({ absolutePath, relativePath })

  it('从单个文件反推出所选文件夹的绝对路径', () => {
    expect(
      rootFoldersFrom([f('D:\\资料\\售后资料\\2026\\a.xlsx', '售后资料/2026/a.xlsx')]),
    ).toEqual(['D:\\资料\\售后资料'])
  })

  it('所选文件夹里的文件再多也只算一个根', () => {
    expect(
      rootFoldersFrom([
        f('D:\\资料\\售后资料\\a.xlsx', '售后资料/a.xlsx'),
        f('D:\\资料\\售后资料\\2026\\b.xlsx', '售后资料/2026/b.xlsx'),
        f('D:\\资料\\售后资料\\2026\\深\\c.xlsx', '售后资料/2026/深/c.xlsx'),
      ]),
    ).toEqual(['D:\\资料\\售后资料'])
  })

  it('一次选多个文件夹时按首次出现顺序全部返回', () => {
    expect(
      rootFoldersFrom([
        f('D:\\甲\\x.txt', '甲/x.txt'),
        f('D:\\乙\\y.txt', '乙/y.txt'),
        f('D:\\甲\\z.txt', '甲/z.txt'),
      ]),
    ).toEqual(['D:\\甲', 'D:\\乙'])
  })

  it('Windows 上大小写不同的同一目录只算一个', () => {
    expect(
      rootFoldersFrom([
        f('D:\\资料\\售后\\a.xlsx', '售后/a.xlsx'),
        f('d:\\资料\\售后\\b.xlsx', '售后/b.xlsx'),
      ]),
    ).toHaveLength(1)
  })

  it('没有目录信息时不给路径_宁可少给也不给半截的', () => {
    // 普通选文件（不是选文件夹）时 relativePath 为空
    expect(rootFoldersFrom([f('D:\\资料\\a.xlsx', '')])).toEqual([])
    // 浏览器预览态拿不到绝对路径
    expect(rootFoldersFrom([f('', '售后/a.xlsx')])).toEqual([])
  })

  it('绝对路径与相对路径对不上时跳过_不产出半截路径', () => {
    // 文件名都对不上，还硬减就会切出 `D:\别处` 这种看似合法的假路径
    expect(rootFoldersFrom([f('D:\\别处\\b.xlsx', '售后/a.xlsx')])).toEqual([])
  })

  it('空列表得到空列表', () => {
    expect(rootFoldersFrom([])).toEqual([])
  })
})
