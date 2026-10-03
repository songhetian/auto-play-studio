import { describe, expect, it } from 'vitest'

import raw from '@/lib/key.cases.json'
import { comboFromEvent, comboLabel, comboTokens, comboToText, normalizeCombo } from '@/lib/keys'

/**
 * Seam：按键语汇（`src/lib/keys.ts`）。
 *
 * `combos` / `combos_errors` 这两组和 `python/tests/test_keys.py` 跑的是**同一份**
 * `key.cases.json`，用来保证前后端对「同一个快捷键」的判断完全一致 ——
 * 配置页说合法、引擎却拒绝（或者反过来），是这套东西最难查的故障。
 *
 * `table` / `patterns` 用来验词表覆盖：漏了哪个别名，配置页就会把能用的键报成非法。
 *
 * `comboFromEvent` 是本模块唯一没有外部真相源的部分，期望值**手写**在这里 ——
 * 它是键位拾取器的核心，写错了用户按 Ctrl+Shift+C 会录进半截东西。
 */

type ComboCase = { why: string; in: unknown; out: string[] }
type ComboError = { why: string; in: unknown; reason_contains: string }
type KeyTable = Record<string, string[]>

const CASES = raw as unknown as {
  modifiers: string[]
  table: KeyTable
  patterns: { letters: string; digits: string; function: string[] }
  combos: ComboCase[]
  combos_errors: ComboError[]
}

describe('词表覆盖', () => {
  // 探针用**数组形态**：字符串形态里 `+` 是分隔符，拿 `'Ctrl+plus'` 之外
  // 的写法探不到 `+` 这个键本身。
  const probe = (alias: string, isModifier: boolean) => normalizeCombo(isModifier ? [alias, 'x'] : [alias])

  it.each(Object.entries(CASES.table))('%s 的每个别名都归一到它自己', (canonical, aliases) => {
    const isModifier = CASES.modifiers.includes(canonical)
    for (const alias of aliases) {
      expect(probe(alias, isModifier)).toEqual({
        combo: isModifier ? [canonical, 'x'] : [canonical],
        reason: '',
      })
    }
  })

  it('规范名自身也必须在别名表里（否则写规范名反而报错）', () => {
    for (const canonical of Object.keys(CASES.table)) {
      expect(probe(canonical, CASES.modifiers.includes(canonical)).reason).toBe('')
    }
  })

  it('大小写不敏感', () => {
    for (const canonical of Object.keys(CASES.table)) {
      const isModifier = CASES.modifiers.includes(canonical)
      const what = probe(canonical, isModifier)
      const upper = probe(canonical.toUpperCase(), isModifier)
      expect(upper).toEqual(what)
    }
  })

  it('修饰键单独按下是非法组合，不是合法单键', () => {
    for (const m of CASES.modifiers) {
      expect(normalizeCombo(m)).toEqual({ combo: [], reason: '还缺一个按键（只按住了修饰键）' })
    }
  })

  it('字母与数字每一位都认得', () => {
    for (const ch of CASES.patterns.letters + CASES.patterns.digits) {
      expect(normalizeCombo(ch)).toEqual({ combo: [ch], reason: '' })
    }
  })

  it('功能键 F1–F24 都认得', () => {
    for (const fn of CASES.patterns.function) {
      expect(normalizeCombo(fn)).toEqual({ combo: [fn], reason: '' })
    }
  })

  it('修饰键清单与词表里的修饰键一致', () => {
    for (const m of CASES.modifiers) {
      expect(CASES.table[m]).toBeDefined()
    }
  })
})

describe('组合键归一化', () => {
  it.each(CASES.combos)('$why → $in', (c) => {
    expect(normalizeCombo(c.in)).toEqual({ combo: c.out, reason: '' })
  })
})

describe('非法组合键必须带原因', () => {
  it.each(CASES.combos_errors)('$why → $in', (c) => {
    const got = normalizeCombo(c.in)
    expect(got.combo).toEqual([])
    expect(got.reason).toContain(c.reason_contains)
  })
})

// ── 键位拾取器 ────────────────────────────────────────────
// 期望值手写，不复用上面的词表常量 —— 否则就是拿同一套算法重算一遍。

type EventLike = {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

const ev = (key: string, mods: Partial<EventLike> = {}): EventLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

const PICKER_CASES: { why: string; e: EventLike; out: string[] | null }[] = [
  { why: '最普通的一个组合', e: ev('c', { ctrlKey: true }), out: ['ctrl', 'c'] },
  { why: '字母是大写说明 Shift 真的按着，要保留', e: ev('C', { ctrlKey: true, shiftKey: true }), out: ['ctrl', 'shift', 'c'] },
  { why: 'Meta 在 Windows 上就是 Win 键', e: ev('a', { metaKey: true }), out: ['win', 'a'] },
  { why: 'Alt 组合', e: ev('F4', { altKey: true }), out: ['alt', 'f4'] },
  { why: '不带修饰键的功能键是合法单键', e: ev('F5'), out: ['f5'] },
  { why: '不带修饰键的字母也是合法单键', e: ev('a'), out: ['a'] },
  { why: 'Shift + 字母', e: ev('S', { shiftKey: true }), out: ['shift', 's'] },
  { why: '方向键要认', e: ev('ArrowLeft', { altKey: true }), out: ['alt', 'left'] },
  { why: '空格', e: ev(' '), out: ['space'] },
  { why: 'Esc 是别名，规范名是 escape', e: ev('Escape'), out: ['escape'] },
  { why: '回车', e: ev('Enter', { ctrlKey: true }), out: ['ctrl', 'enter'] },
  { why: 'Tab', e: ev('Tab', { ctrlKey: true }), out: ['ctrl', 'tab'] },
  { why: '翻页键', e: ev('PageDown', { ctrlKey: true }), out: ['ctrl', 'pagedown'] },
  { why: 'Home / End', e: ev('Home', { ctrlKey: true }), out: ['ctrl', 'home'] },
  { why: 'Delete 与 Backspace 是两个键', e: ev('Backspace', { ctrlKey: true }), out: ['ctrl', 'backspace'] },
  { why: '数字键', e: ev('1', { ctrlKey: true }), out: ['ctrl', '1'] },
  {
    why: '主键盘和小键盘的 5 是同一个 e.key，只能靠 code 区分',
    e: { ...ev('5', { ctrlKey: true }), code: 'Numpad5' },
    out: ['ctrl', 'num5'],
  },
  { why: '小键盘加号是独立的键名 add', e: { ...ev('+'), code: 'NumpadAdd' }, out: ['add'] },
  { why: '小键盘小数点', e: { ...ev('.'), code: 'NumpadDecimal' }, out: ['decimal'] },
  { why: '小键盘回车与主键盘回车同为 enter', e: { ...ev('Enter'), code: 'NumpadEnter' }, out: ['enter'] },
  { why: '没有 code 时按主键盘处理，不能瞎猜', e: ev('5', { ctrlKey: true }), out: ['ctrl', '5'] },
  { why: '三个修饰键一起', e: ev('Delete', { ctrlKey: true, altKey: true }), out: ['ctrl', 'alt', 'delete'] },
  { why: '只按住修饰键时还在录键，返回 null 交给 UI', e: ev('Control', { ctrlKey: true }), out: null },
  { why: 'Shift 独自按下也不该当场定案', e: ev('Shift', { shiftKey: true }), out: null },
  { why: 'Alt 独自按下同理', e: ev('Alt', { altKey: true }), out: null },
  { why: 'Meta 独自按下同理', e: ev('Meta', { metaKey: true }), out: null },
  { why: 'CapsLock 不是能用的主键', e: ev('CapsLock'), out: null },
  { why: '浏览器给不出键名时不要瞎猜', e: ev('Unidentified'), out: null },
  { why: '没见过的键名一律拒绝（白名单）', e: ev('AudioVolumeUp'), out: null },
  {
    why: '+ 本身就是 Shift+= 打出来的，这时 Shift 是被吃掉的，不该再算一个修饰键',
    e: ev('+', { ctrlKey: true, shiftKey: true }),
    out: ['ctrl', '+'],
  },
  {
    why: '字母键上的 Shift 是真的修饰键，与上一个用例的区别正在这里',
    e: ev('C', { ctrlKey: true, shiftKey: true }),
    out: ['ctrl', 'shift', 'c'],
  },
]

describe('键位拾取器', () => {
  it.each(PICKER_CASES)('$why → $e.key', (c) => {
    expect(comboFromEvent(c.e)).toEqual(c.out)
  })

  it('录出来的串能直接吃回去（拾取器与校验口径自洽）', () => {
    for (const c of PICKER_CASES) {
      if (c.out === null) continue
      const back = normalizeCombo(c.out)
      expect(back.reason).toBe('')
      expect(back.combo).toEqual(c.out)
    }
  })
})

describe('展示写法', () => {
  const DISPLAY: { in: string[]; text: string; label: string }[] = [
    { in: ['ctrl', 'c'], text: 'Ctrl+C', label: 'Ctrl + C' },
    { in: ['ctrl', 'shift', 'c'], text: 'Ctrl+Shift+C', label: 'Ctrl + Shift + C' },
    { in: ['win', 'r'], text: 'Win+R', label: 'Win + R' },
    { in: ['escape'], text: 'Esc', label: 'Esc' },
    { in: ['enter'], text: 'Enter', label: 'Enter' },
    { in: ['alt', 'left'], text: 'Alt+Left', label: 'Alt + Left' },
    { in: ['ctrl', '+'], text: 'Ctrl+plus', label: 'Ctrl + +' },
    { in: ['f5'], text: 'F5', label: 'F5' },
  ]

  it.each(DISPLAY)('$in 的文本写法', (c) => {
    expect(comboToText(c.in)).toBe(c.text)
  })

  it.each(DISPLAY)('$in 的展示写法', (c) => {
    expect(comboLabel(c.in)).toBe(c.label)
  })

  it.each(DISPLAY)('$in 的键帽串与展示写法一致', (c) => {
    expect(comboTokens(c.in).join(' + ')).toBe(c.label)
  })

  it('文本写法能再吃回去（写进配置的就是这个串）', () => {
    for (const c of DISPLAY) {
      expect(normalizeCombo(c.text)).toEqual({ combo: c.in, reason: '' })
    }
  })
})
