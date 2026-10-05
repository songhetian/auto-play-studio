import { describe, expect, it } from 'vitest'
import { snapshotUrlOf } from './hitSnapshot'

/**
 * 命中快照的地址拼接。
 *
 * 存的是**相对素材库根目录的路径**（如 `hits/I1/20261005-102231.jpg`），
 * 绝对路径会把用户磁盘结构写进数据库，换机器就全失效。
 */
describe('snapshotUrlOf', () => {
  it('相对路径拼成可访问的完整地址', () => {
    expect(snapshotUrlOf('hits/I1/20261005-102231.jpg')).toContain('/api/hit-snapshots/hits/I1/20261005-102231.jpg')
  })

  it('已经是完整地址的原样返回_避免拼两次', () => {
    // 老数据或外部导入可能存了完整地址
    const full = 'http://127.0.0.1:8731/api/hit-snapshots/hits/I1/a.jpg'
    expect(snapshotUrlOf(full)).toBe(full)
  })

  it('没有快照时返回空串_前端据此不渲染缩略图', () => {
    expect(snapshotUrlOf('')).toBe('')
    expect(snapshotUrlOf(undefined)).toBe('')
  })

  it('Windows 反斜杠也认_存图时可能是 a\\b\\c 形式', () => {
    // 反斜杠不转义的话会变成地址里的 %5C
    expect(snapshotUrlOf('hits\\I1\\a.jpg')).toContain('hits/I1/a.jpg')
  })
})
