/**
 * 快速查单：把用户粘贴的一段文本解析成单号清单。
 *
 * 用户从哪儿粘的都有 —— Excel 一列（换行）、聊天里逗号隔开的、带空格的。
 * 所以换行 / 空格 / 半角逗号 / 全角逗号都当分隔符，去掉空白项与重复，保持原顺序。
 */

/** 单次即时查的上限，与后端 providers.MAX_QUERY_NUMBERS 保持一致 */
export const MAX_QUERY_NUMBERS = 20

export function parseWaybills(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of (text ?? '').split(/[\s,，;；]+/)) {
    const no = part.trim()
    if (no && !seen.has(no)) {
      seen.add(no)
      out.push(no)
    }
  }
  return out
}
