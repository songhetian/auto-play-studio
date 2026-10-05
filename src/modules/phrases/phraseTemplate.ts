/**
 * 话术模板的变量替换。
 *
 * 库里的话术保持模板原样（`您好 {客户名}`），替换只发生在"发给某个客户"的时刻 ——
 * 否则同一句话没法复用到不同客户。
 *
 * 最关键的一条：**缺值时保留占位符原样**。
 * 替换成空串会发出「您好，」这样的残缺话术，比不发更容易出事，
 * 留着 `{客户名}` 至少让人一眼看出还差什么。
 */

/** 只认不带花括号/尖括号/换行的标识符，避免把正文里的括号误判成变量 */
const VAR_RE = /\{([^{}<>\n]{1,40})\}/g

/** 取出模板里用到的变量名（去重、去首尾空格） */
export function templateVars(template: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of (template ?? '').matchAll(VAR_RE)) {
    const name = m[1].trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * 用给定值替换模板里的占位符。
 *
 * 一次性扫描完成（不是"边找边替换"），所以替换值里如果又出现 `{订单号}`
 * 不会被二次展开 —— 否则用户填了个带花括号的内容就会把模板结构搞乱。
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  const src = template ?? ''
  if (!src.includes('{')) return src
  return src.replace(VAR_RE, (whole, rawName: string) => {
    const name = rawName.trim()
    const v = values?.[name]
    // 空字符串/空白视为「没填」，保留占位符
    return v && v.trim() !== '' ? v : whole
  })
}
