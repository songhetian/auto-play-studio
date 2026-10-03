import type { ResolvedTheme } from '@/lib/theme'

/**
 * 图表配色：ECharts 不认 CSS 变量，只能喂具体色值，
 * 所以两套主题各给一份，由 useResolvedTheme() 决定用哪份。
 *
 * 选色约束（由 color.test.ts 守住）：正文与底色对比度 ≥ 4.5:1，
 * 次级文字与网格线 ≥ 3:1，否则深色下会看不清。
 */
export interface ChartPalette {
  /** 画布底色：环形图扇区之间的描边用它，避免出现白缝 */
  surface: string
  text: string
  subText: string
  axis: string
  split: string
  brand: string
  ok: string
  err: string
  skip: string
  wait: string
  areaFill: string
}

const LIGHT: ChartPalette = {
  surface: '#FFFFFF',
  text: '#4E5969',
  subText: '#6B7785',
  axis: '#E5E6EB',
  split: '#F2F3F5',
  brand: '#165DFF',
  ok: '#00B42A',
  err: '#F53F3F',
  skip: '#C9CDD4',
  wait: '#BEDAFF',
  areaFill: 'rgba(22,93,255,.08)',
}

const DARK: ChartPalette = {
  surface: '#232327',
  text: '#C8C8D4',
  subText: '#9494A2',
  axis: '#3A3A44',
  split: '#2E2E36',
  brand: '#4A80FF',
  ok: '#3FBF5F',
  err: '#F56C6C',
  skip: '#55555F',
  wait: '#4A78D8',
  areaFill: 'rgba(74,128,255,.14)',
}

export const chartPalette = (theme: ResolvedTheme): ChartPalette => (theme === 'dark' ? DARK : LIGHT)

/** 统计数字的语义色（运行详情的 KPI 卡） */
export function statColor(theme: ResolvedTheme, kind: 'ok' | 'err' | 'wait' | 'brand' | 'muted'): string {
  const p = chartPalette(theme)
  return { ok: p.ok, err: p.err, wait: p.wait, brand: p.brand, muted: p.text }[kind]
}
