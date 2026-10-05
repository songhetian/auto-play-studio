/**
 * 半自动首响：从话术库里挑出"开新会话要说的第一句话"（纯逻辑，便于测试）。
 *
 * 为什么不新增一个"设为默认首响"的开关：
 *  客服维护话术时最自然的分法就是**分类** —— 把开场白归到「首响」分类即可，
 *  多一个开关就多一处会忘、会不一致的地方。
 *  万一没建这个分类也不能让人用不了：退化成"用得最多的那条"。
 */

/** 约定：归到这个分类的话术就是首响开场白 */
export const FIRST_REPLY_CATEGORY = '首响'

/** 话术的最小形状（只取挑首响用得上的字段，避免与渲染层类型耦合） */
export interface PhraseLike {
  title: string
  body: string
  category: string
  usedCount: number
}

export type FirstReplyReason = 'category' | 'most-used' | 'first'

export interface FirstReplyPick {
  phrase: PhraseLike
  reason: FirstReplyReason
}

/** usedCount 可能缺失/为 NaN：统一按 0 参与比较，否则"任何值 > NaN"都为假会挑错 */
function uses(p: PhraseLike): number {
  return Number.isFinite(p?.usedCount) ? p.usedCount : 0
}

/** 取 usedCount 最大者；并列保持传入顺序（引擎已按常用在前，稳定遍历即可） */
function mostUsed(list: PhraseLike[]): PhraseLike {
  let best = list[0]
  for (const p of list) if (uses(p) > uses(best)) best = p
  return best
}

/** 挑一条首响话术；话术库为空时返回 null（调用方据此提示"先加一条"） */
export function pickFirstReply(phrases: PhraseLike[]): FirstReplyPick | null {
  const list = phrases ?? []
  if (!list.length) return null

  const byCat = list.filter((p) => (p.category ?? '').trim() === FIRST_REPLY_CATEGORY)
  if (byCat.length) return { phrase: mostUsed(byCat), reason: 'category' }

  const top = mostUsed(list)
  return { phrase: top, reason: uses(top) > 0 ? 'most-used' : 'first' }
}

/** 给用户看的一句话：说清这条为什么被选出来（选错时才知道该去改什么） */
export const FIRST_REPLY_HINT: Record<FirstReplyReason, string> = {
  category: '来自「首响」分类',
  'most-used': '话术库里用得最多的一条',
  first: '话术库里的第一条',
}