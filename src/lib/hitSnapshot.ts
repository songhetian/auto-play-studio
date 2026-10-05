import { apiBase } from './api'

/**
 * 命中快照的访问地址。
 *
 * 引擎存的是**相对素材库根目录的路径**（如 `hits/I1/20261005-102231.jpg`）——
 * 存绝对路径会把用户磁盘结构写进数据库，换机器/换目录就全失效。
 *
 * 这里只做拼地址，不发请求：`<img src>` 自己会去取。
 */

/** 已经是完整地址的（含 http 前缀）原样返回，避免拼两次 */
export function snapshotUrlOf(rel: string | undefined | null): string {
  if (!rel) return ''
  if (/^https?:\/\//i.test(rel)) return rel

  // 反斜杠归一：存图时也可能是 a\b\c，直接进地址会变成 %5C
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!norm) return ''

  return `${apiBase()}/hit-snapshots/${norm}`
}
