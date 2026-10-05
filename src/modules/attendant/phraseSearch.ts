/**
 * 话术速查：本地搜索排序 + 插入文本构造（纯逻辑、无副作用，便于测试）。
 *
 * 为什么在本地排序而不是把关键词交给引擎查：
 *  客服按热键的瞬间要的是"立刻看到候选"，一次网络往返（哪怕只有几十毫秒）
 *  都会让人以为没按上。话术总量通常只有几十到几百条，一次全量取回、本地筛，
 *  反而更快也更稳（引擎不可达时依然能查已加载的那份）。
 *
 * 排序取舍（与话术库"常用在前"的直觉一致）：
 *  - 命中的字段有轻重：**标题 > 分类 > 正文**（客服记得的多半是那句说辞的标题）；
 *  - 命中位置越靠前越相关；
 *  - 多用过的稍微往前挪 —— 但这只是"打平时的二次键"，不能盖过相关性，
 *    否则搜什么都先把最常用那条顶到第一，等于没搜。
 *  - 多个关键词按 **AND**：每个词都得在某处命中才算这条匹配。
 */
import type { Phrase } from '@/modules/phrases/usePhrases'
import { templateVars } from '@/modules/phrases/phraseTemplate'

/** 默认返回条数上限：候选太多反而挑不出来，够翻就行 */
export const PHRASE_SEARCH_LIMIT = 50

/** 各字段命中权重（标题 > 分类 > 正文） */
const FIELD_WEIGHT = { title: 100, category: 40, body: 20 } as const

/** 按空白切词。中文没有天然词边界，整串当一个词也是合法输入 */
export function splitQuery(query: string): string[] {
  return (query ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/** 大小写不敏感的字面量查找（ASCII 大小写不敏感；中文不受影响） */
function indexOfFold(haystack: string, needle: string): number {
  return (haystack ?? '').toLowerCase().indexOf(needle.toLowerCase())
}

/**
 * 位置越靠前越相关：按**绝对位置**衰减，不按文本长度归一化。
 *
 * 归一化（`1 - idx/len`）看着更"聪明"，实际是反的：同一个下标 idx=5，
 * 在 200 字的正文里拿到的加成反而比 10 字的正文高 —— 等于奖励"埋得深"。
 */
function positionBonus(idx: number): number {
  return 10 / (1 + idx)
}

/** 单个词对一条话术的得分；没命中返回 -1 */
function scoreToken(phrase: Phrase, token: string): number {
  let best = -1
  const fields: Array<[keyof typeof FIELD_WEIGHT, string]> = [
    ['title', phrase.title],
    ['category', phrase.category],
    ['body', phrase.body],
  ]
  for (const [field, text] of fields) {
    const idx = indexOfFold(text, token)
    if (idx < 0) continue
    const s = FIELD_WEIGHT[field] + positionBonus(idx)
    if (s > best) best = s
  }
  return best
}

/**
 * 一条话术对整串查询的得分；任一关键词没命中即返回 -1（多词 AND）。
 * 空查询返回 0（不筛，交给调用方保持原顺序）。
 */
export function scorePhrase(phrase: Phrase, tokens: string[]): number {
  if (!tokens.length) return 0
  let total = 0
  for (const t of tokens) {
    const s = scoreToken(phrase, t)
    if (s < 0) return -1
    total += s
  }
  // 常用度只带极小权重：仅在相关性打平时才起作用（"常用在前"的二次键）
  return total + Math.min(phrase.usedCount ?? 0, 999) * 0.01
}

/**
 * 搜索并排序。空查询直接返回原顺序的前 `limit` 条 ——
 * 引擎已按"常用在前"排好，这里重排会把这个最符合直觉的规则盖掉。
 */
export function searchPhrases(phrases: Phrase[], query: string, limit = PHRASE_SEARCH_LIMIT): Phrase[] {
  const list = phrases ?? []
  const tokens = splitQuery(query)
  if (!tokens.length) return list.slice(0, limit)

  const scored: Array<{ phrase: Phrase; score: number }> = []
  for (const p of list) {
    const score = scorePhrase(p, tokens)
    if (score >= 0) scored.push({ phrase: p, score })
  }
  // V8 的 sort 是稳定的：同分保持原顺序（即引擎给的常用度顺序）
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((x) => x.phrase)
}

/** 模板里用到的变量名（去重）。用于在面板上提示"这条还差变量没填" */
export function phraseVariables(phrase: Phrase): string[] {
  return templateVars(phrase?.body ?? '')
}

/**
 * 真正插入到目标窗口的文本。
 *
 * - **保留 `{变量}` 占位符原样**：与 `fillTemplate` 的取舍一致 ——
 *   替成空串会发出「您好，」这种残缺话术，宁可留着让人一眼看出还差什么；
 * - 去掉首尾空白、行尾统一成 `\n`：粘贴到聊天框才不会多出空行。
 */
export function buildInsertText(phrase: Phrase): string {
  return (phrase?.body ?? '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

/** 一段被命中的文字区间（用于高亮） */
export interface TextRange {
  start: number
  end: number
}

/** 找出文本里所有命中片段（大小写不敏感），重叠的合并，供 UI 高亮 */
export function matchRanges(text: string, query: string): TextRange[] {
  const tokens = splitQuery(query)
  if (!tokens.length || !text) return []
  const lower = text.toLowerCase()

  const ranges: TextRange[] = []
  for (const t of tokens) {
    const needle = t.toLowerCase()
    let from = 0
    for (;;) {
      const idx = lower.indexOf(needle, from)
      if (idx < 0) break
      ranges.push({ start: idx, end: idx + needle.length })
      from = idx + needle.length
    }
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: TextRange[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    // 只合并**真正重叠**的区间；紧挨着的两次命中仍是两段（各自高亮）
    if (last && r.start < last.end) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}