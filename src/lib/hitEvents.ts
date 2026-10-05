/**
 * 命中事件列表的纯逻辑（工单 02 · S7）。
 *
 * 查询串与「通知结果」文案单独放在这里：前者少带一个参数筛选就静默失效，
 * 后者要把 ok / fail / skip 三种结局说成人话（用户得知道这条到底通知出去没有）。
 */
export interface HitEvent {
  id: number
  instanceId: string
  tool: string
  ruleId: string
  /** 靠什么命中的：image / ocr / keyword …—— 判断规则可不可靠全靠它 */
  matchedBy: string
  level: 'info' | 'warn' | 'alert'
  title: string
  detail: string
  similarity: number | null
  rect: number[] | null
  /**
   * 命中瞬间的截图（相对素材库根目录的路径，空串 = 没存成）。
   * 用 `snapshotUrlOf` 拼成可访问地址再喂给 <img src>。
   */
  snapshot: string
  /** 逐通道结果：{通道名: 'ok' | 'fail: 原因' | 'skip: 静音时段'} */
  notified: Record<string, string>
  read: boolean
  /**
   * 处置状态（库里的客观事实）：pending=还没人确认 / acknowledged=已确认闭环。
   * 界面上要显示「未确认超时」时，用 `dispositionOf` 按 ts 推算，不要直接读它。
   */
  disposition: 'pending' | 'acknowledged'
  /** 确认时刻（localtime），空串 = 从没确认过 */
  ackAt: string
  ts: string
}

export interface HitEventQuery {
  instanceId?: string
  tool?: string
  level?: string
  limit?: number
  /** 向后翻页的游标：上一页最后一条的 id */
  beforeId?: number
  unreadOnly?: boolean
}

export function hitEventQuery(q: HitEventQuery): string {
  const p = new URLSearchParams()
  if (q.instanceId) p.set('instanceId', q.instanceId)
  if (q.tool) p.set('tool', q.tool)
  if (q.level) p.set('level', q.level)
  if (q.limit != null) p.set('limit', String(q.limit))
  if (q.beforeId != null) p.set('beforeId', String(q.beforeId))
  if (q.unreadOnly) p.set('unreadOnly', 'true')
  return p.toString()
}

const CHANNEL_LABEL: Record<string, string> = {
  desktop: '桌面通知',
  webhook: 'IM 机器人',
}

const MATCHED_BY_LABEL: Record<string, string> = {
  image: '图像',
  ocr: '文字识别',
  keyword: '关键词',
  test: '测试发送',
}

export function channelLabel(name: string): string {
  return CHANNEL_LABEL[name] ?? name
}

export function matchedByLabel(name: string): string {
  return MATCHED_BY_LABEL[name] ?? name
}

/**
 * 把逐通道结果说成一句话。
 *
 * `fail` 必须带原因（否则用户只知道「没通知」），`skip` 必须说清是静音
 * （否则会被当成发送失败，用户会去查通道配置）。
 */
export function notifiedText(notified: Record<string, string>): string {
  const parts: string[] = []
  const ok: string[] = []

  for (const [name, result] of Object.entries(notified ?? {})) {
    const label = channelLabel(name)
    if (result === 'ok') {
      ok.push(label)
    } else if (result.startsWith('fail:')) {
      parts.push(`${label}发送失败：${result.slice('fail:'.length).trim()}`)
    } else if (result.startsWith('skip:')) {
      parts.push(`${label}：${result.slice('skip:'.length).trim()}跳过`)
    } else {
      parts.push(`${label}：${result}`)
    }
  }

  if (ok.length) parts.unshift(`已通知：${ok.join('、')}`)
  return parts.length ? parts.join('；') : '未通知'
}

/** 通知是否出了问题（失败或跳过）—— 列表里用来决定要不要标成警示色 */
export function notifiedHasIssue(notified: Record<string, string>): boolean {
  return Object.values(notified ?? {}).some((r) => r !== 'ok')
}

// ── 处置状态（告警确认闭环）───────────────────────────────────

/**
 * 界面上的处置态：库里两档 + 推算出来的第三档。
 *
 * 「未确认超时」不落库、由 ts 推算 —— 它随时钟走（今天没超时明天就超了），
 * 存下来当天就过期。所以这一层必须是能注入 `now` 的纯函数。
 */
export type Disposition = 'pending' | 'acknowledged' | 'timeout'

/** 告警响应时限：超过还没人确认就算「未确认超时」—— 漏看一条告警比误报更危险 */
export const ACK_TIMEOUT_MS = 5 * 60 * 1000

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  pending: '待确认',
  acknowledged: '已确认',
  timeout: '未确认超时',
}

/**
 * 引擎的 `ts` 是 SQLite 的 `YYYY-MM-DD HH:MM:SS`（**本地时间**，不是 ISO）。
 * 直接 `new Date()` 在个别引擎上会判非法，补个 `T` 再解析才稳。
 */
export function parseHitTs(ts: string): number {
  if (!ts) return Number.NaN
  return new Date(ts.replace(' ', 'T')).getTime()
}

/** 命中事件的显示处置态（`now` 可注入，便于钉住边界） */
export function dispositionOf(
  e: Pick<HitEvent, 'disposition' | 'ts'>,
  now: number = Date.now(),
): Disposition {
  if (e.disposition === 'acknowledged') return 'acknowledged'
  // 时间判不出来时按「待确认」算：宁可少喊一次超时，也不要把正常告警误标成漏看
  const at = parseHitTs(e.ts)
  if (Number.isNaN(at)) return 'pending'
  return now - at >= ACK_TIMEOUT_MS ? 'timeout' : 'pending'
}

/**
 * 数一数"未确认且已超时"的命中条数 —— 悬浮球待处理角标用的就是它。
 *
 * 只数超时那一种：刚命中还没到时限的不该催，已确认的更不该算进"没人管"。
 */
export function timeoutPendingCount(
  events: Array<Pick<HitEvent, 'disposition' | 'ts'>>,
  now: number = Date.now(),
): number {
  let n = 0
  for (const e of events ?? []) {
    if (dispositionOf(e, now) === 'timeout') n++
  }
  return n
}
