import type { ZodIssue, ZodTypeAny } from 'zod'

/**
 * 把 Zod 的校验结果摊平成「字段路径 → 第一条错误」。
 *
 * 目的：设置页不该等到点保存弹一句「保存失败」，
 * 而应在字段旁边直接标出哪一项不合格，并让保存按钮说明为什么不可用。
 *
 * 另外必须把 zod 自带的英文兜底文案（"String must contain at least 1 character(s)"）
 * 翻成人话 —— 用户看到的每一句报错都应该是中文，且要说清「哪里不对」。
 * 我们自己 superRefine 写的 message 已经是中文，原样保留。
 */
export function zodFieldErrors(schema: ZodTypeAny, value: unknown): Record<string, string> {
  const result = schema.safeParse(value)
  if (result.success) return {}

  const out: Record<string, string> = {}
  for (const issue of result.error.issues) {
    const key = issue.path.join('.')
    // 同一字段可能有多条（superRefine 会追加），只留第一条，避免文案互相打架
    if (!(key in out)) out[key] = humanize(issue)
  }
  return out
}

/** zod 内置 issue → 用户看得懂的中文 */
export function humanize(issue: ZodIssue): string {
  // 自己写的自定义校验已经带了想说的话（本项目里一律是中文），原样保留。
  // zod 的 issue 上不区分「自定义消息」和「内置兜底」，所以用「含不含中日韩字符」来判定：
  // 含中文 = 我们写的；纯 ASCII = zod 的内置英文，需要翻译。
  if (issue.code === 'custom' || /[\u3400-\u9fff\u3040-\u30ff]/.test(issue.message)) return issue.message

  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined' ? '这一项还没填' : '填写内容与要求不符'
    case 'too_small': {
      const min = issue.minimum
      if (issue.type === 'string') return min <= 1 ? '不能为空' : `至少需要 ${min} 个字符`
      if (issue.type === 'array') return min <= 1 ? '至少要有一项' : `至少需要 ${min} 项`
      return `不能小于 ${min}`
    }
    case 'too_big': {
      const max = issue.maximum
      if (issue.type === 'string') return `最多 ${max} 个字符`
      if (issue.type === 'array') return `最多 ${max} 项`
      return `不能大于 ${max}`
    }
    case 'invalid_enum_value':
      return '取值不在允许范围内'
    case 'invalid_string':
      return issue.validation === 'url' ? '请填写完整网址（含 http:// 或 https://）' : '格式不正确'
    case 'invalid_union':
    case 'invalid_union_discriminator':
      return '配置结构与当前工具类型不匹配'
    case 'invalid_literal':
      return '取值不在允许范围内'
    case 'unrecognized_keys':
      return '有无法识别的字段'
    case 'not_finite':
      return '请填写一个有限数字'
    default:
      // 兜底也给中文，宁可笼统也不能漏英文出去
      return '填写内容不符合要求'
  }
}

/** 有没有任何字段级错误 */
export const hasErrors = (errors: Record<string, string>): boolean => Object.keys(errors).length > 0
