/**
 * 变量自动填（工单 04 · ③）。
 *
 * 插入带 `{客户名}` 的话术时，从选区 / 剪贴板推断变量值，能推断就替掉，
 * 推断不出就**保留占位符**（调用方再提醒客服手填）—— 宁可让客服看到占位符，
 * 也不要发出「您好，」这种残缺话术，或把错误的名字发出去。
 */
import { parseSelection } from '@/lib/parseSelection'
import { phraseVariables } from '@/modules/attendant/phraseSearch'

/** 变量名 → 从选区解析结果里取哪一类的映射 */
const VAR_KIND: Record<string, 'names' | 'orderNos'> = {
  客户名: 'names',
  客户: 'names',
  订单号: 'orderNos',
  订单: 'orderNos',
}

/**
 * 推断话术模板里的变量值。
 *
 * @param body   话术正文（含 {变量} 占位符）
 * @param source 选区文字或剪贴板文字（用来推断）
 * @returns 能推断出来的 {变量名: 值}；推断不出的变量不在返回里
 */
export function inferVars(body: string, source: string): Record<string, string> {
  const vars = phraseVariables({ title: '', body, category: '', usedCount: 0, createdAt: '', updatedAt: '' } as never)
  if (!vars.length || !source.trim()) return {}

  const parsed = parseSelection(source)
  const out: Record<string, string> = {}

  for (const name of vars) {
    const kind = VAR_KIND[name]
    if (!kind) continue // 暂时只支持客户名 / 订单号两类；别的变量保持占位符
    const hit = parsed[kind][0]
    if (hit) out[name] = hit
  }
  return out
}

/**
 * 把推断到的值填进话术正文。
 *
 * 只替换 `inferVars` 返回的那些；其余占位符原样保留（调用方据此提醒）。
 */
export function applyInferred(body: string, values: Record<string, string>): string {
  if (!Object.keys(values).length) return body
  return body.replace(/\{(\w+)\}/g, (full, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : full,
  )
}
