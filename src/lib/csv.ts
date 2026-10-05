/**
 * CSV 导出共用的小工具：转义、拼文本、起文件名。
 *
 * 三处「导出」都踩过同样的两个坑，所以收在这里：
 *
 * 1. **开头必须有 BOM。** 不带 BOM 的 UTF-8 CSV，Excel 会按本地编码去解 ——
 *    中文全变乱码。这是导出类功能最常见的报障，而且报的人往往以为是数据坏了。
 * 2. **半角逗号、双引号、换行要按 CSV 规则转义。** 中文文案里的全角逗号「，」
 *    不是分隔符，不该跟着加引号。
 */

/** 单元格转义：只处理半角逗号、双引号、换行。 */
export function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** 表头 + 数据行 → 带 BOM 的 CSV 文本。行尾用 \r\n，Excel 兼容性最好。 */
export function csvText(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows].map((cells) => cells.map(escapeCsvCell).join(','))
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}

/** 导出文件名：`前缀-实例名-年月日-时分.csv`，路径非法字符换成下划线。 */
export function csvFileName(prefix: string, instanceName: string, at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`
  const safe = instanceName.replace(/[\\/:*?"<>|]/g, '_').trim() || '实例'
  return `${prefix}-${safe}-${stamp}.csv`
}
