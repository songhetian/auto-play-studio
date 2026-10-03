/**
 * 按键语汇：组合键归一化 + 键位拾取。
 *
 * **为什么和 `hotkey.ts` 是两个模块**：系统里有两套互不相干的键位语汇 ——
 *
 *  - `hotkey.ts` 走 **Electron accelerator**（`CommandOrControl` / `Super` / `Return`），
 *    是给主进程注册全局快捷键用的；
 *  - 这里是 **pyautogui 的词表**（`ctrl` / `win` / `enter`），是「让目标程序替你按一下
 *    Ctrl+C」用的。两者长得像，混用会出现「录进去了但按不出来」。
 *
 * 以前指令层根本没有归一化器：配置页写 `Ctr+C` 会一路原样传到
 * `pyautogui.hotkey('Ctr', 'C')`；更糟的是写成一个串（`hotkey('ctrl+c')`），
 * pyautogui 会把整串当成**一个键名**，**静默什么都不做**。
 *
 * 词表是**白名单**：认不出来就报错，不给「猜一个差不多的键」的机会。
 * `python/engine/keys.py` 是同一份语义的第二实现，两侧跑同一组黄金用例
 * （`key.cases.json`）。
 */

/** 修饰键的规范顺序。写反了也要归一到同一个串 —— 否则「同一个快捷键」会变成两个。 */
export const MODIFIERS = ['ctrl', 'alt', 'shift', 'win'] as const

const MODIFIER_RANK: Record<string, number> = Object.fromEntries(MODIFIERS.map((m, i) => [m, i]))

/** 别名 → 规范名。规范名本身也在表里，作为它自己的别名。 */
const ALIASES: Record<string, string> = {
  // 修饰键
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  win: 'win',
  winleft: 'win',
  super: 'win',
  cmd: 'win',
  command: 'win',
  meta: 'win',
  // 命名键
  enter: 'enter',
  return: 'enter',
  escape: 'escape',
  esc: 'escape',
  tab: 'tab',
  space: 'space',
  空格: 'space',
  backspace: 'backspace',
  back: 'backspace',
  delete: 'delete',
  del: 'delete',
  insert: 'insert',
  ins: 'insert',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pgup: 'pageup',
  pagedown: 'pagedown',
  pgdn: 'pagedown',
  up: 'up',
  arrowup: 'up',
  down: 'down',
  arrowdown: 'down',
  left: 'left',
  arrowleft: 'left',
  right: 'right',
  arrowright: 'right',
  capslock: 'capslock',
  printscreen: 'printscreen',
  prtsc: 'printscreen',
  prtscr: 'printscreen',
  // 小键盘与标点：规范名就是 pyautogui 认的那一个字符
  add: 'add',
  subtract: 'subtract',
  multiply: 'multiply',
  divide: 'divide',
  decimal: 'decimal',
  '+': '+',
  plus: '+',
  '-': '-',
  minus: '-',
  '=': '=',
  equal: '=',
  '/': '/',
  slash: '/',
  '.': '.',
  period: '.',
  ',': ',',
  comma: ',',
  // 规则族：小键盘数字、功能键、字母、数字
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`num${i}`, `num${i}`])),
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, `f${i + 1}`])),
  ...Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((ch) => [ch, ch])),
  ...Object.fromEntries([...'0123456789'].map((ch) => [ch, ch])),
}

export interface NormalizeResult {
  /** 成功时是归一化后的按键串，失败时为空数组 */
  combo: string[]
  /** 成功时为空串，失败时是给人看的原因 */
  reason: string
}

/**
 * 把用户写的按键整理成 pyautogui 认得的一串。
 *
 * 不抛异常是有意的：配置页的键位拾取器要拿 `reason` 当场提示，
 * 引擎侧拿到 `reason` 再翻成 `CommandError`，两边共用同一份判断。
 */
export function normalizeCombo(raw: unknown): NormalizeResult {
  let parts: string[]
  if (Array.isArray(raw)) parts = raw.map((p) => String(p))
  else if (raw === null || raw === undefined) parts = []
  else parts = String(raw).split('+')

  // 空段一律丢掉：`Ctrl++C` 与 `Ctrl+C` 等价，`['Ctrl','','C']` 同理
  const tokens = parts.map((p) => p.trim()).filter(Boolean)
  if (!tokens.length) return { combo: [], reason: '请填一个按键' }

  const modifiers: string[] = []
  const keys: string[] = []

  for (const token of tokens) {
    const canonical = ALIASES[token.toLowerCase()]
    if (canonical === undefined) return { combo: [], reason: `不知道「${token}」是什么键` }

    const bucket = canonical in MODIFIER_RANK ? modifiers : keys
    if (bucket.includes(canonical)) return { combo: [], reason: `「${canonical}」重复了` }
    bucket.push(canonical)
  }

  // 只按住修饰键的话，driver 会静默什么都不做
  if (!keys.length) return { combo: [], reason: '还缺一个按键（只按住了修饰键）' }

  modifiers.sort((a, b) => MODIFIER_RANK[a] - MODIFIER_RANK[b])
  return { combo: [...modifiers, ...keys], reason: '' }
}

// ── 键位拾取 ──────────────────────────────────────────────

/** 键盘事件里我们真正用到的字段（`KeyboardEvent` 的子集，测试里手写即可） */
export interface KeyEventLike {
  key: string
  /** 用来区分小键盘与主键盘：同一个 `key` 值，`code` 不同 */
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/** `KeyboardEvent.key` → 规范名。表里没有的一律拒绝（白名单）。 */
const EVENT_KEYS: Record<string, string> = {
  ' ': 'space',
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  CapsLock: 'capslock',
  PrintScreen: 'printscreen',
  '+': '+',
  '-': '-',
  '=': '=',
  '/': '/',
  '.': '.',
  ',': ',',
}

/** `KeyboardEvent.code` → 规范名，只在能区分小键盘时才用得上 */
const EVENT_CODES: Record<string, string> = {
  NumpadAdd: 'add',
  NumpadSubtract: 'subtract',
  NumpadMultiply: 'multiply',
  NumpadDivide: 'divide',
  NumpadDecimal: 'decimal',
  NumpadEnter: 'enter',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Numpad${i}`, `num${i}`])),
}

/** 按下时自己就是修饰键（还没录到主键），或压根不是能用的主键 */
const IGNORED_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'OS', 'Dead', 'Unidentified'])

/**
 * 从键盘事件取出归一化的按键串；只按了修饰键时返回 `null`（还在录键中，交给 UI 继续等）。
 *
 * 一个必须处理的坑：**`+` 本身就是 Shift+= 打出来的**。如果照搬 `shiftKey`，
 * 用户想录 `Ctrl+加号` 会得到 `Ctrl+Shift+加号` —— 那是另一个键。所以当主键是
 * 「靠 Shift 才打出来的非字母数字字符」时，把 Shift 吃掉；字母/数字键上的 Shift
 * 是真的修饰键，要保留（`Ctrl+Shift+C` 与 `Ctrl+C` 是两个不同的键）。
 */
export function comboFromEvent(e: KeyEventLike): string[] | null {
  if (!e.key || IGNORED_KEYS.has(e.key)) return null

  let main: string | undefined = e.code ? EVENT_CODES[e.code] : undefined
  if (main === undefined) {
    main = EVENT_KEYS[e.key]
    if (main === undefined) {
      if (/^[a-zA-Z]$/.test(e.key)) main = e.key.toLowerCase()
      else if (/^[0-9]$/.test(e.key)) main = e.key
      else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(e.key)) main = e.key.toLowerCase()
      else return null
    }
  }

  const modifiers: string[] = []
  if (e.ctrlKey) modifiers.push('ctrl')
  if (e.altKey) modifiers.push('alt')
  // 非字母数字单字符靠 Shift 打出来，此时的 Shift 已经被吃进这个字符里了
  const shiftIsConsumed = main.length === 1 && !/[a-zA-Z0-9]/.test(main)
  if (e.shiftKey && !shiftIsConsumed) modifiers.push('shift')
  if (e.metaKey) modifiers.push('win')

  modifiers.sort((a, b) => MODIFIER_RANK[a] - MODIFIER_RANK[b])
  return [...modifiers, main]
}

// ── 展示写法 ──────────────────────────────────────────────

/** 规范名 → 写进配置/输入框的 token。**必须能再被 `normalizeCombo` 吃回去。** */
const TOKEN_TEXT: Record<string, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  win: 'Win',
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  capslock: 'CapsLock',
  printscreen: 'PrintScreen',
  // `+` 是分隔符，只能写成 `plus`，否则 `Ctrl+plus` 会被拆成两个键
  '+': 'plus',
  '-': '-',
  '=': '=',
  '/': '/',
  '.': '.',
  ',': ',',
  add: 'add',
  subtract: 'subtract',
  multiply: 'multiply',
  divide: 'divide',
  decimal: 'decimal',
}

function tokenText(canonical: string): string {
  const named = TOKEN_TEXT[canonical]
  if (named !== undefined) return named
  if (/^num\d$/.test(canonical)) return canonical
  return canonical.toUpperCase()
}

/** `['ctrl','c']` → `'Ctrl+C'`（存进配置、回填输入框用的写法） */
export function comboToText(combo: string[]): string {
  return combo.map(tokenText).join('+')
}

/** `['ctrl','c']` → `['Ctrl','C']`（渲染成一串键帽用；`+` 显示成 `+` 而不是 `plus`） */
export function comboTokens(combo: string[]): string[] {
  return combo.map((c) => (c === '+' ? '+' : tokenText(c)))
}

/** `['ctrl','c']` → `'Ctrl + C'`（给人看的写法，`+` 不写成 `plus`） */
export function comboLabel(combo: string[]): string {
  return comboTokens(combo).join(' + ')
}
