/** 快速查单结果里的一条：`ok === false` 表示这一条没查成，`status` 本身就是给人话的原因。 */
export interface LogiStatusItem {
  status: string
  ok?: boolean
}

/** 结果色调：完成 / 在途 / 灰（查无） / 红（失败）。页面据此上色，不用自己判断文案。 */
export type LogiTone = 'ok' | 'moving' | 'muted' | 'bad'

export interface LogiStatus {
  label: string
  tone: LogiTone
}

/** 「查无轨迹」这类不是错误、但也不算查到的状态：灰色带过，别吓用户。 */
const MUTED = new Set(['无轨迹', '查无结果'])

const TONES: Array<[string, LogiTone]> = [
  ['已签收', 'ok'],
  ['运输中', 'moving'],
  ['派送中', 'moving'],
]

/** 把引擎给的状态翻成一句人话 + 一个色调。 */
export function humanStatus(item: LogiStatusItem): LogiStatus {
  const status = item.status ?? ''
  // 查不成时状态本身已经是原因（待人工验证 / 查询失败），原样展示，红调。
  if (item.ok === false) return { label: status || '查询失败', tone: 'bad' }
  if (MUTED.has(status)) return { label: status, tone: 'muted' }
  const hit = TONES.find(([name]) => status.includes(name))
  if (hit) return { label: status, tone: hit[1] }
  return { label: status || '未知', tone: 'muted' }
}

export interface LogiRunSummary {
  total: number
  ok: number
  failed: number
  headline: string
}

/** 一轮结果的摘要：区分「查到」与「未查到/失败」，给 toast 用一句话。 */
export function summarizeRun(items: LogiStatusItem[]): LogiRunSummary {
  const total = items.length
  const failed = items.filter((it) => it.ok === false || MUTED.has(it.status ?? '')).length
  const ok = total - failed
  const headline = failed === 0 ? `全部查到：共 ${total} 条` : `查到 ${ok} 条，未查到 ${failed} 条，共 ${total} 条`
  return { total, ok, failed, headline }
}
