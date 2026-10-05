/**
 * 分类标签的输入解析。
 *
 * 界面上写「多个用逗号分隔」，但客服实际会顺手打顿号或空格 ——
 * 三种都收，解析口径只有这一处。
 */
export function parseTags(raw: string): string[] {
  return (raw ?? '')
    .split(/[,，、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}
