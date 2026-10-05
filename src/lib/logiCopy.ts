import { csvFileName, csvText } from '@/lib/csv'

/** 复制用的一行结果：字段都可能缺，缺的留空。 */
export interface LogiCopyRow {
  no?: string
  company?: string
  status?: string
  signed_at?: string
  trace?: string
}

const HEADER = ['单号', '公司', '状态', '签收时间', '轨迹'] as const

/** 单元格里的制表符/换行会毁掉 TSV 的行列结构，压成空格。 */
const cell = (v: unknown): string => String(v ?? '').replace(/[\t\r\n]+/g, ' ')

/** CSV 里的换行可以留在格子里，由转义负责保命，不用压平。 */
const csvCell = (v: unknown): string => String(v ?? '')

/** 把本轮查单结果转成 TSV（带表头），粘到 Excel 里能直接分列。 */
export function toTsv(rows: LogiCopyRow[]): string {
  const lines = [HEADER.join('\t')]
  for (const r of rows) {
    lines.push([r.no, r.company, r.status, r.signed_at, r.trace].map(cell).join('\t'))
  }
  return lines.join('\n')
}

/** 把本轮查单结果转成 CSV（带 BOM），另存为文件后 Excel 打开不乱码。 */
export function toCsv(rows: LogiCopyRow[]): string {
  return csvText(
    HEADER,
    rows.map((r) => [r.no, r.company, r.status, r.signed_at, r.trace].map(csvCell)),
  )
}

/** 导出文件名。结论不塞进 CSV 里，而是带在文件名上 */
export function logiCsvName(instanceName: string, at = new Date()): string {
  return csvFileName('物流查询', instanceName, at)
}
