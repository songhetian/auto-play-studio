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
  /** 逐通道结果：{通道名: 'ok' | 'fail: 原因' | 'skip: 静音时段'} */
  notified: Record<string, string>
  read: boolean
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
