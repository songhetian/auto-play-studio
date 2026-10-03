import type { PendingRow } from '@/lib/api'

/**
 * 待人工确认清单 → CSV 文本。
 *
 * 两个不写就会出事的地方：
 *
 * 1. **开头必须有 BOM。** 不带 BOM 的 UTF-8 CSV，Excel 会按本地编码去解 ——
 *    中文全变乱码。这是「导出」这类功能最常见的报障，而且报的人往往以为是数据坏了。
 * 2. **逗号、引号、换行要按 CSV 规则转义。** 失败原因里出现逗号是常态
 *    （`打不开，请检查`），不转义会把一行劈成两列。
 *
 * 一行一个失败行、行号在最前面：拿到这份清单的人是照着行号回原表里补的。
 */
export function pendingCsv(pending: PendingRow[]): string {
  const lines = [
    ['行号', '主键', '失败原因'],
    ...pending.map((p) => [String(p.row), p.key, p.reason] as string[]),
  ]
  // 行尾用 \r\n：Excel 对 \n 的兼容性不如 \r\n，尤其是从剪贴板往回复制的时候
  return '\uFEFF' + lines.map((cells) => cells.map(escapeCell).join(',')).join('\r\n') + '\r\n'
}

function escapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** 导出文件名。结论不塞进 CSV 里（会让表格多出两行不是数据的行），而是带在文件名上 */
export function pendingFileName(instanceName: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`
  const safe = instanceName.replace(/[\\/:*?"<>|]/g, '_').trim() || '实例'
  return `待人工确认-${safe}-${stamp}.csv`
}
