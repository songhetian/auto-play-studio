/**
 * 面板里「一键查件」结果的 CSV 导出（工单 04 · ②）。
 *
 * 纯函数：把引擎返回的运单结果拼成带 BOM 的 CSV，复用 `lib/csv` 的转义与命名。
 * 不碰 DOM、不碰网络，便于单测；落盘动作交给 `lib/download` 的 `downloadTextFile`。
 */
import { csvText, csvFileName } from '@/lib/csv'
import type { LogiQueryItem } from '@/lib/api'

/** 导出表头：单号 / 公司 / 状态 / 签收时间 / 轨迹 / 是否查成 / 说明 */
export const LOGI_CSV_HEADER = ['单号', '快递公司', '状态', '签收时间', '轨迹', '是否查成', '说明'] as const

/** 运单结果 → CSV 文本（UTF-8 + BOM，Excel 直接能开不乱码） */
export function buildLogiCsv(items: LogiQueryItem[]): string {
  const rows = (items ?? []).map((it) => [
    it.no,
    it.company,
    it.status,
    it.signed_at,
    it.trace,
    it.ok ? '是' : '否',
    it.message,
  ])
  return csvText(LOGI_CSV_HEADER, rows)
}

/** 导出文件名：`物流查询-年月日-时分.csv` */
export function logiCsvFileName(at: Date = new Date()): string {
  return csvFileName('物流查询', '', at)
}
