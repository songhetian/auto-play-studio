/**
 * 基于意图快速定位画面（离线启发式）。
 *
 * 用户在海量图片/视频帧里只想找"检查是否遗漏配件"这类目标，不愿从头翻。
 * 离线、无视觉模型时，能做的只有**按已有线索匹配**：每条素材都有名字 / 标签 / OCR 文本 /
 * 标注，意图句拆成检索词后，和这些文本做重叠打分，命中多的排前面。
 *
 * 这正是"快速定位"的两个前提：
 *  1. 素材得带可检索的文本（名字/标签/OCR）—— 纯黑盒帧没有文本就定位不到；
 *  2. 意图要能落成关键词 —— "遗漏配件"能拆成「配件」，但"这画面好不好看"拆不出词，
 *     这种语义意图必须上 LLM 视觉（见 docs/intent-recognition-feasibility.md）。
 *
 * 纯函数、不碰 DOM，便于单测，也便于后端复用同一套打分。
 */

export interface IntentItem {
  id: string
  /** 展示名（视频帧会是「帧1.50s」这类） */
  name?: string
  /** 标签 */
  tag?: string
  /** 标注 / 关注点（如「配件」「包装」） */
  labels?: string[]
  /** OCR 识别出的画面文字 */
  ocr?: string
}

export interface IntentHit {
  id: string
  /** 召回率：命中词数 / 意图词数（0~1） */
  score: number
  /** 实际命中的检索词，便于界面提示"为什么这条相关" */
  matched: string[]
}

/**
 * 轻量同义词表：缓解"命名不规范导致漏召回"。
 *
 * 同一组的词互为等价（如「螺丝」「螺栓」「螺钉」口语/书面混用），匹配时任一命中都算
 * 该意图词命中。不在意图句里做同义词"造句"，避免引入无关词污染召回率分母。
 *
 * 这是**模块内置默认**：保证不传 store 时也能直接用。用户可在素材库「同义词管理」UI
 * 里自定义（见 src/stores/synonymStore.ts），把 groups 经 buildSynonymMap 转成查表后，
 * 作为 locateByIntent 第 3 参传入即可覆盖本默认——无需改代码重打包。
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['螺丝', '螺栓', '螺钉'],
]

/**
 * 把同义词组（每组互为等价）展开成 O(1) 查表：term -> 整组（含自身）。
 * 放在模块顶层，便于测试与「可自定义」场景复用——store 里的用户词表也走它。
 */
export function buildSynonymMap(groups: readonly (readonly string[])[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const group of groups) {
    for (const term of group) map.set(term, [...group])
  }
  return map
}

/** term -> 等价词集合（含自身），O(1) 查同义词 */
const SYNONYMS: Map<string, string[]> = buildSynonymMap(SYNONYM_GROUPS)

/**
 * 把意图句拆成检索词：离线、无分词模型，所以用字符级 n-gram 覆盖。
 * - 英文 / 数字按词；
 * - 中文取 2-gram（抓"配件""遗漏"这种词）+ 单字兜底（避免"配件"被切成"配""件"后仍可能命中）；
 * - 去重。
 */
export function intentTerms(intent: string): string[] {
  const s = (intent || '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (!s) return []
  const terms: string[] = []
  // 英文 / 数字词
  for (const w of s.split(/[^a-z0-9一-鿿]+/i)) {
    if (w) terms.push(w)
  }
  // 中文 2-gram + 单字兜底
  const cjk = s.replace(/[^一-鿿]/g, '')
  for (let i = 0; i + 2 <= cjk.length; i++) terms.push(cjk.slice(i, i + 2))
  for (const ch of cjk) terms.push(ch)
  // 去重，保序
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of terms) {
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/** 汇总一条素材的可检索文本（小写）。 */
function itemText(it: IntentItem): string {
  return [it.name, it.tag, ...(it.labels ?? []), it.ocr].filter(Boolean).join(' ').toLowerCase()
}

/**
 * 按意图给素材打分排序，返回命中的（score>0）且按分数降序。
 *
 * 分数为召回率（命中词 / 意图词），同分时多命中词优先 —— 命中越全越靠前。
 */
export function locateByIntent(
  intent: string,
  items: IntentItem[],
  synonymMap: Map<string, string[]> = SYNONYMS,
): IntentHit[] {
  const terms = intentTerms(intent)
  if (!terms.length || !items.length) return []
  // 同义词展开：每个意图词可借同义词命中（如「螺丝」也能命中「螺栓」），
  // 但分母仍用原意图词数，避免同义词污染召回率。
  const matchSets = terms.map((t) => synonymMap.get(t) ?? [t])
  const hits: IntentHit[] = []
  for (const it of items) {
    const text = itemText(it)
    if (!text) continue
    const matched: string[] = []
    terms.forEach((t, i) => {
      if (matchSets[i].some((m) => text.includes(m))) matched.push(t)
    })
    if (!matched.length) continue
    const score = Number((matched.length / terms.length).toFixed(3))
    hits.push({ id: it.id, score, matched })
  }
  return hits.sort((a, b) => b.score - a.score || b.matched.length - a.matched.length)
}
