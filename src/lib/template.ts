/**
 * 模板渲染（前端侧）。
 *
 * ⚠️ 这是 `python/engine/template.py` 的**第二实现** —— 配置页要做实时预览，
 * 渲染逻辑两端都需要，而两份实现必然会漂移。对策是两侧跑**同一组黄金用例**
 * （`src/lib/template.cases.json` 与 `python/tests/fixtures/template_cases.json`
 * 内容相同，由 `python/tests/test_template_cases_parity.py` 看守副本一致）。
 * 任何一侧改了语义，另一侧立刻红。
 *
 * 报错文案也是契约的一部分 —— 保存校验要在两端说同一句话，所以文案逐字对齐后端。
 *
 * 金额一律走字符串精确转「分」，**不经过 Number**：`Number('1.005')` 是 1.0049999…，
 * 而 Python 的 `Decimal('1.005')` 是精确值，两边会一个进位一个不进 ——
 * 而这条结果是要发给客户的。
 *
 * 已知分歧：整数值的浮点无法跨语言对齐（Python `str(100.0)` = `'100.0'`，
 * JS `String(100.0)` = `'100'`），所以黄金用例里禁止出现整数值浮点。
 */

export type TemplateRow = {
  values?: Record<string, unknown> | null
  row_no?: number
  key?: string
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}

/** {任意内容}，中文列名也能匹配 */
const PLACEHOLDER = /\{([^{}]*)\}/g

/** 金额清洗：逗号、各种空白、半角 ¥(U+00A5)、全角 ￥(U+FFE5) */
const AMOUNT_NOISE = /[,\s\u00a5\uffe5]/g

/** 金额的形状：可选符号 + 整数段 + 可选小数段 */
const AMOUNT_SHAPE = /^([+-]?)(\d*)(?:\.(\d*))?$/

/** 取不到值的哨兵。不能用 undefined —— 它就是「这一列的值是空的」 */
const MISSING = Symbol('missing')

const CN_DIGIT = '零壹贰叁肆伍陆柒捌玖'
const CN_UNIT = ['', '拾', '佰', '仟']
const CN_GROUP = ['', '万', '亿', '万亿']

/** 人民币大写支持的脱敏类型 */
const MASK_KINDS = ['id', 'phone', 'name']

/** 接受的日期输入格式，**长的排前面**（否则 `YYYY-MM-DD` 会先吃掉带时分秒的串） */
const DATE_PATTERNS = [
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/,
  /^(\d{4})-(\d{2})-(\d{2})$/,
  /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
  /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/,
  /^(\d{4})\/(\d{2})\/(\d{2})$/,
  /^(\d{4})年(\d{1,2})月(\d{1,2})日 (\d{2}):(\d{2}):(\d{2})$/,
  /^(\d{4})年(\d{1,2})月(\d{1,2})日 (\d{2}):(\d{2})$/,
  /^(\d{4})年(\d{1,2})月(\d{1,2})日$/,
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/,
]

/** ISO 串里的毫秒：`...T13:20:00.123Z` 先剥掉小数位再按上面的清单解析 */
const ISO_FRACTION = /(T\d{2}:\d{2}:\d{2})\.\d+/

/** 输出用的占位符。注意 `MM` 是月、`mm` 是分，靠大小写区分 */
const DATE_TOKENS = /YYYY|MM|DD|HH|mm|ss/g

// ── 数字字符串上的精确运算（金额可能长到 18 位，过一遍 Number 就丢了） ──

/** 数字串 +1。入参必须是规范化的（无前导零、无符号） */
function plusOne(digits: string): string {
  const chars = digits.split('')
  let i = chars.length - 1
  for (; i >= 0; i -= 1) {
    if (chars[i] === '9') {
      chars[i] = '0'
      continue
    }
    chars[i] = String(Number(chars[i]) + 1)
    break
  }
  return (i < 0 ? '1' : '') + chars.join('')
}

function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+/, '') || '0'
}

/** 千分位。`1234567` -> `1,234,567` */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 清洗过的金额文本 -> 「分」的整数字符串。解析不了返回 null。
 *
 * 只做字符串运算：`Number('1.005')` 是 1.0049999…，直接 `*100` 再舍入
 * 会和 Python 的 Decimal 走上不同的路。
 */
function toCents(cleaned: string): string | null {
  const m = AMOUNT_SHAPE.exec(cleaned)
  if (!m || (!m[2] && !m[3])) return null

  const negative = m[1] === '-'
  let whole = stripLeadingZeros(m[2] || '0')
  const frac = (m[3] || '').padEnd(3, '0')

  // 看第 3 位小数决定是否进位（half-up = 见 5 就往上，正负都是远离零）
  let low = Number(frac.slice(0, 2)) + (frac[2] >= '5' ? 1 : 0)
  if (low >= 100) {
    low -= 100
    whole = plusOne(whole)
  }

  const digits = stripLeadingZeros(whole + String(low).padStart(2, '0'))
  return (negative && digits !== '0' ? '-' : '') + digits
}

/** 单元格金额 -> 「分」的整数字符串。空值返回 null，脏数据抛错 */
function amountToCents(value: unknown, formatter: string): string | null {
  const text = value === null || value === undefined ? '' : String(value)
  const cleaned = text.replace(AMOUNT_NOISE, '')
  if (!cleaned) return null // 空不是错，只是没有金额

  const cents = toCents(cleaned)
  if (cents === null) {
    throw new TemplateError(`格式化器 ${formatter} 处理不了「${text}」，它需要一个金额`)
  }
  return cents
}

// ── 格式化器：签名统一是 (值, 参数) -> 文本 ──────────────────

function money(value: unknown, _arg: string): string {
  const cents = amountToCents(value, 'money')
  if (cents === null) return ''

  const negative = cents.startsWith('-')
  const padded = (negative ? cents.slice(1) : cents).padStart(3, '0')
  return `${negative ? '-' : ''}${groupThousands(padded.slice(0, -2))}.${padded.slice(-2)}`
}

/** 一个 4 位组（0-9999）的大写，组内连续的零合并成一个「零」 */
function fourDigits(n: number): string {
  const ds = String(n).padStart(4, '0')
  let out = ''
  let pending = false

  for (let i = 0; i < 4; i += 1) {
    const d = Number(ds[i])
    if (d === 0) {
      if (out) pending = true
      continue
    }
    if (pending) {
      out += CN_DIGIT[0]
      pending = false
    }
    out += CN_DIGIT[d] + CN_UNIT[3 - i]
  }
  return out
}

/** 整数部分按 4 位一组进位。0 返回空串，由调用方补「零元整」 */
function rmbInteger(digits: string): string {
  const n = stripLeadingZeros(digits)
  if (n === '0') return ''

  const groups: string[] = []
  for (let end = n.length; end > 0; end -= 4) {
    groups.push(n.slice(Math.max(0, end - 4), end))
  }

  let out = ''
  let needZero = false
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = Number(groups[i])
    if (g === 0) {
      if (out) needZero = true
      continue
    }
    if (needZero) {
      out += CN_DIGIT[0]
      needZero = false
    }
    out += fourDigits(g) + CN_GROUP[i]
    // 低一组不足千位时必须补零：壹万零壹，而不是 壹万壹
    const next = i > 0 ? Number(groups[i - 1]) : 0
    if (i > 0 && next > 0 && next < 1000) needZero = true
  }
  return out
}

function rmb(value: unknown, _arg: string): string {
  const cents = amountToCents(value, 'rmb')
  if (cents === null) return ''

  const negative = cents.startsWith('-')
  const padded = (negative ? cents.slice(1) : cents).padStart(3, '0')
  const sign = negative ? '负' : ''

  const jiao = Number(padded[padded.length - 2])
  const fen = Number(padded[padded.length - 1])
  const integer = rmbInteger(padded.slice(0, -2))

  if (jiao === 0 && fen === 0) return `${sign}${integer || CN_DIGIT[0]}元整`

  let body = integer ? `${integer}元` : ''
  if (jiao > 0) body += CN_DIGIT[jiao] + '角'
  // 有元有分、中间没有角：壹佰元零伍分
  else if (fen > 0 && integer) body += CN_DIGIT[0]
  if (fen > 0) body += CN_DIGIT[fen] + '分'

  return sign + body
}

/** 认不出类型时按姓名处理 —— 宁可多打几个星号，也别把身份证原样发出去 */
function guessMaskKind(text: string): string {
  if (/^\d+$/.test(text) && (text.length === 15 || text.length === 18)) return 'id'
  if (/^\d+$/.test(text) && text.length === 11) return 'phone'
  return 'name'
}

function mask(value: unknown, arg: string): string {
  const text = String(value).trim()
  if (!text) return ''

  const kind = arg || guessMaskKind(text)
  if (!MASK_KINDS.includes(kind)) {
    throw new TemplateError(`格式化器 mask 不认识「${kind}」，可用：id / phone / name`)
  }

  if (kind === 'id' && text.length > 8) {
    return text.slice(0, 4) + '*'.repeat(text.length - 8) + text.slice(-4)
  }
  if (kind === 'phone' && text.length > 7) {
    return text.slice(0, 3) + '*'.repeat(text.length - 7) + text.slice(-4)
  }

  // 姓名，以及位数不够、按 id/phone 脱不出东西的情况：只留首尾
  if (text.length <= 1) return text
  if (text.length === 2) return `${text[0]}*`
  return text[0] + '*'.repeat(text.length - 2) + text.slice(-1)
}

/** `cut` / `pad` 的位数参数。写错就报错 —— 当成 0 位处理会把内容整段抹掉 */
const MAX_WIDTH = 200

function widthArg(arg: string, formatter: string): number {
  if (!/^\d+$/.test(arg)) {
    throw new TemplateError(`格式化器 ${formatter} 需要一个位数（例如 ${formatter}:8），收到「${arg}」`)
  }
  const width = Number(arg)
  // 上界保护：位数过大时 `padStart` 会抛 RangeError（不是 TemplateError），
  // 于是保存校验会甩出一个用户看不懂的原生异常
  if (width > MAX_WIDTH) {
    throw new TemplateError(`格式化器 ${formatter} 的位数太大（${width}），最多 ${MAX_WIDTH}`)
  }
  return width
}

function cut(value: unknown, arg: string): string {
  const text = String(value)
  const width = widthArg(arg, 'cut')
  return text.length <= width ? text : `${text.slice(0, width)}…`
}

function pad(value: unknown, arg: string): string {
  // 位数先校验：空值也不该放过写错的参数，否则保存时校验会漏掉
  const width = widthArg(arg, 'pad')
  const text = String(value)
  // 空的不补零 —— 补出 0000 会真的发到客户那边去
  return text ? text.padStart(width, '0') : ''
}

function upper(value: unknown, _arg: string): string {
  return String(value).toUpperCase()
}

function lower(value: unknown, _arg: string): string {
  return String(value).toLowerCase()
}

function trim(value: unknown, _arg: string): string {
  return String(value).trim()
}

/** 空值兜底。**纯空白也算空** —— 发出去在客户那边就是一片空白 */
function fallback(value: unknown, arg: string): string {
  const text = String(value)
  return text.trim() ? text : arg
}

/**
 * 把单元格里的时间解析成各字段；空值返回 null，认不出来抛错。
 *
 * 字符串只认固定的那一小撮格式 —— **不接受 `02/10/2026` 这种有歧义的写法**，
 * 猜错的日期会直接变成客户投诉，不如让它整行失败。不做时区换算。
 */
function parseDate(value: unknown): number[] | null {
  const text = String(value).trim().replace(ISO_FRACTION, '$1').replace(/Z$/, '')
  if (!text) return null

  for (const pattern of DATE_PATTERNS) {
    const m = pattern.exec(text)
    if (!m) continue
    return [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
    ]
  }

  throw new TemplateError(`格式化器 date 认不出「${value}」，它需要一个日期`)
}

function date(value: unknown, arg: string): string {
  if (!arg) {
    throw new TemplateError('格式化器 date 需要一个格式，例如 date:YYYY-MM-DD')
  }

  const parts = parseDate(value)
  if (parts === null) return ''

  const [y, mo, d, h, mi, s] = parts
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const table: Record<string, string> = {
    YYYY: String(y).padStart(4, '0'),
    MM: pad2(mo),
    DD: pad2(d),
    HH: pad2(h),
    mm: pad2(mi),
    ss: pad2(s),
  }
  return arg.replace(DATE_TOKENS, (token) => table[token])
}

/** 格式化器注册表：名字 -> (值, 参数) -> 文本 */
const FORMATTERS: Record<string, (value: unknown, arg: string) => string> = {
  money: money,
  rmb: rmb,
  mask: mask,
  cut: cut,
  pad: pad,
  upper: upper,
  lower: lower,
  trim: trim,
  default: fallback,
  date: date,
}

// ── 解析 ──────────────────────────────────────────────────

/**
 * 把占位符原文解析成 (值, 格式化器规格)。取不到值返回 `MISSING`。
 *
 * 兼容退路：先按竖线左边当列名查，查不到再拿整串原文查一次 ——
 * 于是「列名里真的带竖线」的老配置不会因为新语法而失效。
 */
/**
 * 只看**自有属性**，不看原型链。
 *
 * `'constructor' in values` 对任何普通对象都为真 —— 曾经因此让 `{constructor}`
 * 渲染成 `function Object() { [native code] }`、`{值|constructor}` 静默原样输出，
 * 「名字不认识就报错」的承诺被绕过。
 */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function lookup(raw: string, values: Record<string, unknown>): [unknown, string | null] {
  const at = raw.indexOf('|')
  if (at < 0) {
    return hasOwn(values, raw) ? [values[raw], null] : [MISSING, null]
  }

  const key = raw.slice(0, at).trim()
  if (hasOwn(values, key)) return [values[key], raw.slice(at + 1).trim()]
  if (hasOwn(values, raw)) return [values[raw], null] // 这压根不是格式化器，是一个含竖线的列名
  return [MISSING, null]
}

/** 套用格式化器。名字不认识就报错，绝不静默降级成原样输出 */
function applySpec(value: unknown, spec: string | null, raw: string): string {
  if (spec === null) return value === null || value === undefined ? '' : String(value)

  // null 视作空串（与 `{列名}` 口径一致），**空串仍然会进格式化器** ——
  // `default:x` 的存在意义就是接管空值；也只有这样 `mask` 不会把空值变成「null」。
  const text = value === null || value === undefined ? '' : String(value)

  const at = spec.indexOf(':')
  const name = (at < 0 ? spec : spec.slice(0, at)).trim()
  // 白名单查自有属性：`FORMATTERS['constructor']` 会命中 Object 函数（truthy），
  // 于是静默原样输出；`__proto__` 更会被当成函数调用抛原生 TypeError
  const formatter = hasOwn(FORMATTERS, name) ? FORMATTERS[name] : undefined
  if (!formatter) {
    throw new TemplateError(`未知的格式化器「${name}」，占位符 {${raw}} 无法替换`)
  }

  return formatter(text, at < 0 ? '' : spec.slice(at + 1).trim())
}

/**
 * 渲染一个占位符。**解析的唯一出口** ——
 *
 * `renderTemplate` 和 `templateIssues` 都走这里，所以「跑起来会失败」与
 * 「保存时说会失败」不可能对不上：报错文案就是同一句话。
 */
function renderOne(raw: string, values: Record<string, unknown>, row: TemplateRow): string {
  const [value, spec] = lookup(raw, values)
  if (value !== MISSING) return applySpec(value, spec, raw)

  if (raw === '行号') return String(row.row_no ?? '')
  if (raw === '主键') return String(row.key ?? '')

  const at = raw.indexOf('|')
  const key = at < 0 ? raw : raw.slice(0, at).trim()
  throw new TemplateError(`当前行没有「${key}」这一列，占位符 {${raw}} 无法替换`)
}

/**
 * 把 `{列名}` / `{列名|格式化器}` 换成当前行的值。
 *
 * 取不到就抛 TemplateError —— 与其把占位符原样发出去，不如让这一行失败。
 */
export function renderTemplate(text: string, row: TemplateRow): string {
  const values = (row.values ?? {}) as Record<string, unknown>
  return text.replace(PLACEHOLDER, (_all, inner: string) => renderOne(inner.trim(), values, row))
}

/**
 * 保存时就查出这条模板的所有问题。没问题返回空数组。
 *
 * 做法是拿「所有列都在、值都为空」的一行 dry-run 一遍 —— 于是它复用渲染那条路，
 * 不需要第二套解析器，也不会和运行时给出不同的判断。
 * 逐条占位符收集而不是遇到第一个就抛：一次把话说完，用户才不用改一个跑一次。
 *
 * ⚠️ 前提是格式化器的**参数校验与值无关**（`pad` 就是为此把位数校验提到了前面），
 * 否则 `{订单号|pad:abc}` 会因为「值是空的」而被放过。
 */
export function templateIssues(text: string, columns: string[]): string[] {
  const values: Record<string, unknown> = {}
  for (const column of columns) values[column] = ''
  const row: TemplateRow = { values }

  const issues: string[] = []
  // 用一个全新的正则：PLACEHOLDER 是共享的带 g 常量，别在这里碰它的 lastIndex
  for (const m of text.matchAll(new RegExp(PLACEHOLDER.source, 'g'))) {
    try {
      renderOne(m[1].trim(), values, row)
    } catch (err) {
      if (err instanceof TemplateError) issues.push(err.message)
      else throw err
    }
  }
  return issues
}

/**
 * 把模板切成「普通文字」与「占位符」两类，写错的那个标 `bad` —— 配置页预览据此标红。
 *
 * **入参是整段模板**，不是单个占位符。判定复用 `templateIssues`，而它只认带花括号的写法；
 * 曾经这段逻辑内联在组件里，喂进去的是剥掉花括号的 `金额|money`，
 * 于是 `bad` 永远是 false：报错列表照常有内容、红字一个都没有。
 * 「文字对但样式错」是只读 innerText 的验收发现不了的，所以这条得由测试守住。
 */
export function templateParts(text: string, columns: string[]): { text: string; bad: boolean }[] {
  const out: { text: string; bad: boolean }[] = []
  let last = 0

  for (const m of text.matchAll(new RegExp(PLACEHOLDER.source, 'g'))) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at), bad: false })
    out.push({ text: m[0], bad: columns.length > 0 && templateIssues(m[0], columns).length > 0 })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), bad: false })
  return out
}
