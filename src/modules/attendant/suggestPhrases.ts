/**
 * 选区自动建议：把客服框住的客户消息，变成一串可能用得上的话术（纯逻辑、便于测试）。
 *
 * 为什么不能把整句当查询词：客户消息是"我的订单什么时候发货"这种整句，
 * 而话术标题是"发货时效"这类短语，整句去搜一条也匹配不上
 * （话术速查那套是多个关键词 AND，整句只会全军覆没）。
 *
 * 于是改成：把消息拆成 2~4 字的连续片段，看哪些片段出现在话术里 ——
 * 命中的字数越多越相关。片段落点也有轻重：**标题 > 分类 > 正文**，
 * 因为客服是靠标题认出"就是那句说辞"的。
 *
 * 全部在本地算：话术总量小，且这一步常在"引擎刚好没连上"时也要能用。
 */
import type { Phrase } from '@/modules/phrases/usePhrases'

/** 从消息里取的连续片段长度范围：2 字太短易误伤，超过 4 字几乎必然匹配不上 */
export const SUGGEST_MIN_N = 2
export const SUGGEST_MAX_N = 4

/** 默认建议条数：候选太多反而挑不出来，够翻一屏就行 */
export const SUGGEST_LIMIT = 20

/**
 * 入选门槛（加权命中字数）。
 * 权重是 标题 3 / 分类 2 / 正文 1，所以：标题命中 2 字（6 分）即入选，
 * 而正文要凑够 6 个字才算数 —— 正文只蹭到两个字就推荐，全是噪声。
 */
export const SUGGEST_MIN_SCORE = 6

const FIELD_WEIGHT = { title: 3, category: 2, body: 1 } as const

/** 空格在匹配时一律忽略：中文没有词边界，带不带空格都该视为同一串 */
const normalize = (s: string): string => (s ?? '').toLowerCase().replace(/\s+/g, '')

/** 至少含一个字母/数字/汉字才算有意义，避免标点组成的片段到处"命中" */
const HAS_WORD = /[a-z0-9\u4e00-\u9fff]/

/** 消息里所有 2~4 字的连续片段（去重） */
function messageNgrams(message: string): string[] {
  const s = normalize(message)
  const out = new Set<string>()
  for (let n = SUGGEST_MIN_N; n <= SUGGEST_MAX_N; n++) {
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.slice(i, i + n)
      if (HAS_WORD.test(g)) out.add(g)
    }
  }
  return [...out]
}

/**
 * 一段文本里被这些片段覆盖到的字数（同一字符只算一次，重叠片段不重复计分）。
 * 只数"覆盖"，不数"命中次数"—— 否则一句话术把某个词重复十遍就会刷分。
 */
function coveredLength(text: string, ngrams: string[]): number {
  const s = normalize(text)
  if (!s) return 0
  const hit = new Array<boolean>(s.length).fill(false)
  for (const g of ngrams) {
    let from = 0
    for (;;) {
      const idx = s.indexOf(g, from)
      if (idx < 0) break
      for (let k = idx; k < idx + g.length; k++) hit[k] = true
      // +1 而非 +g.length：允许自重叠（如 "aa" 在 "aaa" 里出现两次）
      from = idx + 1
    }
  }
  let n = 0
  for (const h of hit) if (h) n++
  return n
}

/** 一条话术对这条消息的相关度（加权命中字数） */
function scorePhrase(phrase: Phrase, ngrams: string[]): number {
  return (
    FIELD_WEIGHT.title * coveredLength(phrase.title, ngrams) +
    FIELD_WEIGHT.category * coveredLength(phrase.category, ngrams) +
    FIELD_WEIGHT.body * coveredLength(phrase.body, ngrams)
  )
}

/**
 * 推荐话术：按相关度降序，过滤掉弱命中，最多 `limit` 条。
 * 空消息、空话术库、全都匹配不上时返回空数组 —— 调用方据此提示"手动搜一下"。
 */
export function suggestPhrases(message: string, phrases: Phrase[], limit = SUGGEST_LIMIT): Phrase[] {
  const ngrams = messageNgrams(message)
  if (!ngrams.length) return []

  const scored: Array<{ phrase: Phrase; score: number }> = []
  for (const p of phrases ?? []) {
    const score = scorePhrase(p, ngrams)
    if (score >= SUGGEST_MIN_SCORE) scored.push({ phrase: p, score })
  }
  // 稳定排序：同分保持引擎给的原顺序（即"常用在前"）
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((x) => x.phrase)
}