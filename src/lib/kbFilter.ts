/**
 * 命中片段的高亮切分。
 *
 * 引擎回的是**原文片段**，不是带标记的富文本 —— 这是对的：把渲染细节固化进索引，
 * 换个前端就得重建一次库。所以「哪几个字是命中的」由前端重新找一遍。
 *
 * 规则要和引擎的匹配口径尽量一致，否则会出现「这条明明命中了，却一个字都没高亮」：
 *   ① 大小写不敏感
 *   ② 同一个起点上取更长的词 —— 搜「退款」不该先被「退」按 1 个字截断
 *   ③ 已高亮的区间不再被别的词重叠覆盖
 *
 * 高亮不出来的一种情况是**正常的**：拼音命中（tkzc → 退款政策）在原文里没有对应的字。
 * 硬凑一个高亮反而会指错地方，所以宁可不标。
 */

export interface Segment {
  text: string
  /** true = 这段是命中的关键词 */
  hit: boolean
}

interface Range {
  start: number
  end: number
}

/** 查询串切成词：空格分隔、去重、统一小写。与引擎的多词口径一致（默认 AND）。 */
export function searchTerms(query: string): string[] {
  const seen = new Set<string>()
  for (const raw of query.trim().toLowerCase().split(/\s+/)) {
    if (raw) seen.add(raw)
  }
  return [...seen]
}

/** 找出所有不重叠的命中区间，按位置排序。导出的目的是让规则本身可被直接测。 */
export function findHitRanges(text: string, terms: string[]): Range[] {
  if (!text || !terms.length) return []
  const hay = text.toLowerCase()

  // 先把所有出现位置收集齐，再统一定序：**位置靠前的优先，同一位置取更长的词**。
  //
  // 不能按「词」逐个落位 —— 那样谁先落位取决于词表顺序，同一个片段会因为关键词写颠倒了
  // 而高亮出不同结果；更糟的是排序若掺进 locale 比较，不同机器上还会不一样。
  const candidates: Range[] = []
  for (const term of terms) {
    let from = 0
    for (;;) {
      const at = hay.indexOf(term, from)
      if (at < 0) break
      candidates.push({ start: at, end: at + term.length })
      from = at + 1
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end)

  const out: Range[] = []
  for (const r of candidates) {
    // 与已落位区间相交就跳过：高亮块保持整块，不做二次切分
    if (out.some((k) => r.start < k.end && r.end > k.start)) continue
    out.push(r)
  }
  return out
}

/**
 * 把一段文本切成「命中 / 未命中」的片段，交给渲染层拼。
 *
 * 拼回去必须等于原文 —— 高亮是显示层的装饰，不该改变文本本身
 * （用户要能复制这一行去别处搜）。
 */
export function highlightSegments(text: string, terms: string[]): Segment[] {
  if (!text) return []
  const ranges = findHitRanges(text, terms)
  if (!ranges.length) return [{ text, hit: false }]

  const out: Segment[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) out.push({ text: text.slice(cursor, r.start), hit: false })
    out.push({ text: text.slice(r.start, r.end), hit: true })
    cursor = r.end
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false })
  return out
}
