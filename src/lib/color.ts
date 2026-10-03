/**
 * 颜色与对比度工具（WCAG 2.1 相对亮度公式）。
 *
 * 存在的理由：深色主题不是「把颜色反过来」那么简单，
 * 图表与文字用的色值必须有可验证的对比度下限，
 * 否则深色下会糊成一片。设计系统里这条规则应该由代码守住。
 */

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** sRGB 单通道线性化 */
function linearize(channel: number): number {
  const s = channel / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG 相对亮度：纯黑 0，纯白 1 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(linearize)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 对比度：1:1 到 21:1，与参数顺序无关 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}
