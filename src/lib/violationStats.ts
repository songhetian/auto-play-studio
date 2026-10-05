/**
 * 违规统计页的纯逻辑（工单 04 · ⑤）。
 *
 * 查询串与 CSV 导出单独放这里：前者少带一个参数筛选就静默失效，
 * 后者要管 BOM 与半角逗号转义（否则 Excel 打开中文乱码 / 列错位）。
 * 期望值全在 violationStats.test.ts 里手写。
 */
import { csvFileName, csvText } from '@/lib/csv'

export type ViolationLevel = 'high' | 'mid' | 'low'

export interface ViolationEvent {
  id: number
  word: string
  level: ViolationLevel
  /** 本机用户（A 线即坐席） */
  seat: string
  instanceId: string
  tool: string
  /** 命中上下文（前 200 字） */
  detail: string
  ts: string
}

export interface ViolationQuery {
  word?: string
  level?: string
  seat?: string
  /** YYYY-MM-DD：只取这一天后命中的 */
  dateFrom?: string
  /** YYYY-MM-DD：只取这一天前命中的 */
  dateTo?: string
  limit?: number
}

export interface ViolationSummary {
  total: number
  /** 按词计数，level 取该词的最高危级 */
  byWord: Array<{ word: string; level: ViolationLevel; count: number }>
  /** 按危级计数：{ high: n, mid: n, low: n } */
  byLevel: Record<string, number>
}

/**
 * 查询串：空值不进；这样页面不勾筛选时打的就是「看全局」的干净请求，
 * 不会因为带了一堆空参数让后端 `WHERE 1=1 AND x=''` 静默失效。
 */
export function violationQuery(q: ViolationQuery): string {
  const p = new URLSearchParams()
  if (q.word) p.set('word', q.word)
  if (q.level) p.set('level', q.level)
  if (q.seat) p.set('seat', q.seat)
  if (q.dateFrom) p.set('dateFrom', q.dateFrom)
  if (q.dateTo) p.set('dateTo', q.dateTo)
  if (q.limit != null) p.set('limit', String(q.limit))
  return p.toString()
}

/** 危级 → 中文标签（统计卡与表格着色都用它） */
export const VIOLATION_LEVEL_LABEL: Record<string, string> = {
  high: '高危',
  mid: '中危',
  low: '低危',
}

export function violationLevelLabel(level: string): string {
  return VIOLATION_LEVEL_LABEL[level] ?? level
}

/** 违规事件 → CSV 文本（带 BOM，中文不乱码）。一列一个字段，上下文里的逗号已转义。 */
export function buildViolationCsv(rows: ViolationEvent[]): string {
  return csvText(
    ['时间', '违禁词', '危级', '坐席', '实例', '上下文'],
    rows.map((r) => [
      r.ts,
      r.word,
      violationLevelLabel(r.level),
      r.seat,
      r.instanceId,
      r.detail,
    ]),
  )
}

/** 导出文件名：`违规记录-年月日-时分.csv` */
export function violationFileName(at: Date = new Date()): string {
  return csvFileName('违规记录', '', at)
}
