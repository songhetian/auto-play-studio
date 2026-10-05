import type { PendingRow } from '@/lib/api'
import { csvFileName, csvText } from '@/lib/csv'

/**
 * 待人工确认清单 → CSV 文本。
 *
 * 一行一个失败行、行号在最前面：拿到这份清单的人是照着行号回原表里补的。
 * BOM 与转义规则见 `lib/csv`。
 */
export function pendingCsv(pending: PendingRow[]): string {
  return csvText(
    ['行号', '主键', '失败原因'],
    pending.map((p) => [String(p.row), p.key, p.reason]),
  )
}

/** 导出文件名。结论不塞进 CSV 里（会让表格多出两行不是数据的行），而是带在文件名上 */
export function pendingFileName(instanceName: string, at = new Date()): string {
  return csvFileName('待人工确认', instanceName, at)
}
