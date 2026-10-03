/**
 * 快捷键：解析、规范化、冲突检测。
 *
 * 分两层，产品语义不同，不能混：
 *  - **全局键**（F8 / F9 / F10）：主进程注册，系统级生效。自动化跑起来时焦点在目标程序上，
 *    全局键是唯一还能按到的入口；代价是会和目标程序的同名按键抢。
 *  - **窗口键**（Ctrl+S 保存、/ 搜索）：只在应用窗口内生效，不抢系统按键。
 *
 * 三个动作**都是每实例的**（同一个键可以给不同实例用，主进程按确定规则挑一个）：
 * `run` 开始 · `toggle` 暂停/继续 · `stop` 停止。
 *
 * 这一层只管字符串怎么写法、有没有冲突，具体注册与路由在主进程。
 */

export const HOTKEY_ACTIONS = ['run', 'toggle', 'stop'] as const
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number]

/** 动作的固定顺序。冲突列表、注册表、界面都按它排，三处才不会各排各的 */
const ACTION_RANK: Record<HotkeyAction, number> = { run: 0, toggle: 1, stop: 2 }

export const HOTKEY_ACTION_LABEL: Record<HotkeyAction, string> = {
  run: '开始执行',
  toggle: '暂停 / 继续',
  stop: '停止',
}

/** 一个全局键按下去，作用到谁身上 */
export const HOTKEY_SCOPES = ['window', 'tool'] as const
export type HotkeyScope = (typeof HOTKEY_SCOPES)[number]

export const HOTKEY_SCOPE_LABEL: Record<HotkeyScope, string> = {
  window: '仅这一个实例',
  tool: '同工具的所有实例',
}

export interface HotkeyMap {
  run: string
  toggle: string
  stop: string
  scope: HotkeyScope
}

export const DEFAULT_HOTKEY_MAP: HotkeyMap = { run: 'F8', toggle: 'F9', stop: 'F10', scope: 'window' }

/** 修饰键的规范写法（Electron accelerator 用语） */
const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'CommandOrControl',
  control: 'CommandOrControl',
  cmd: 'Super',
  command: 'Super',
  meta: 'Super',
  super: 'Super',
  win: 'Super',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
}

/** 修饰键的固定顺序：写法统一，两个键才有可比性 */
const MODIFIER_ORDER = ['CommandOrControl', 'Super', 'Alt', 'Shift']

/** 非字母数字键的写法（KeyboardEvent.key → accelerator） */
const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  Escape: 'Escape',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert',
  '-': '-',
  '=': '=',
  '[': '[',
  ']': ']',
  ';': ';',
  "'": "'",
  ',': ',',
  '.': '.',
  '/': '/',
  '\\': '\\',
  '`': '`',
}

/** 单键规范化；认不出来返回 null（宁可拒绝，也不要注册出一个错误按键） */
export function normalizeKey(key: string): string | null {
  if (!key) return null
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase()
  if (KEY_ALIASES[key]) return KEY_ALIASES[key]
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase()
  return null
}

/** 把用户/存档里的写法（'f9'、'ctrl+s'）整理成规范形式（'F9'、'CommandOrControl+S'） */
export function normalizeAccel(input: string | undefined | null): string | null {
  if (!input) return null
  const parts = String(input)
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return null

  const mods = new Set<string>()
  let key: string | null = null

  for (const raw of parts) {
    const lower = raw.toLowerCase()
    if (MODIFIER_ALIASES[lower]) {
      mods.add(MODIFIER_ALIASES[lower])
      continue
    }
    const k = normalizeKey(raw)
    if (k) key = k
  }

  if (!key) return null
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+')
}

/**
 * 全局键的安全底线：必须是功能键，或带至少一个修饰键。
 *
 * 没有这条，用户可以把暂停键设成 `S` —— 注册成功后全系统的 S 都打不出来，
 * 这类问题用户自己很难联想到是工具造成的。
 */
export function validateGlobalAccel(accel: string | null): { ok: true } | { ok: false; reason: string } {
  if (!accel) return { ok: false, reason: '请按下一个按键' }
  const parts = accel.split('+')
  const key = parts[parts.length - 1]
  const hasModifier = parts.length > 1
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return { ok: true }
  if (/^(Home|End|Insert|PageUp|PageDown|Delete|Return|Space|Up|Down|Left|Right|Escape|Tab)$/.test(key)) {
    return { ok: true }
  }
  if (hasModifier) return { ok: true }
  return { ok: false, reason: '全局快捷键需要用功能键，或搭配 Ctrl / Alt / Shift 使用' }
}

/** 从键盘事件取出规范化按键串；只按了修饰键时返回 null（还在录键中） */
export function accelFromEvent(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return null
  const key = normalizeKey(e.key)
  if (!key) return null

  const mods: string[] = []
  if (e.ctrlKey) mods.push('CommandOrControl')
  if (e.metaKey) mods.push('Super')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')

  return [...MODIFIER_ORDER.filter((m) => mods.includes(m)), key].join('+')
}

/** 展示用：CommandOrControl → Ctrl，Super → Win，按 Windows 习惯叫 */
export function formatAccel(accel: string): string {
  return accel
    .split('+')
    .map((p) => (p === 'CommandOrControl' ? 'Ctrl' : p === 'Super' ? 'Win' : p))
    .join(' + ')
}

/** 当前事件是否命中某个窗口内快捷键（Ctrl+S、/ 这类） */
export function matchesAccel(
  accel: string,
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
): boolean {
  const fromEvent = accelFromEvent(e)
  return !!fromEvent && fromEvent === accel
}

/** 从实例 config 里读热键；缺项逐项回落，老配置不用迁移 */
export function hotkeyMapOf(config: unknown): HotkeyMap {
  const raw =
    config && typeof config === 'object' ? (config as { hotkeys?: Partial<HotkeyMap> }).hotkeys ?? {} : {}
  const scope: HotkeyScope = raw.scope === 'tool' ? 'tool' : 'window'
  return {
    run: normalizeAccel(raw.run) ?? DEFAULT_HOTKEY_MAP.run,
    toggle: normalizeAccel(raw.toggle) ?? DEFAULT_HOTKEY_MAP.toggle,
    stop: normalizeAccel(raw.stop) ?? DEFAULT_HOTKEY_MAP.stop,
    scope,
  }
}

export interface HotkeyOwner {
  id: string
  name: string
  tool: string
  hotkeys: HotkeyMap
}

export interface HotkeyConflict {
  accel: string
  action: HotkeyAction
  owners: HotkeyOwner[]
}

/**
 * 找出「同一个键被多个实例占了同一个动作」的情况。
 *
 * 这不是错误而是需要告知的事实：键会由主进程按确定规则挑一个实例执行
 * （焦点窗口 > 最近用过的 > 最早的），其余实例不会被动到 —— 但用户应该知道这件事。
 */
export function findHotkeyConflicts(owners: HotkeyOwner[]): HotkeyConflict[] {
  const byKey = new Map<string, HotkeyConflict>()

  for (const action of HOTKEY_ACTIONS) {
    const grouped = new Map<string, HotkeyOwner[]>()
    for (const o of owners) {
      const accel = o.hotkeys[action]
      if (!accel) continue
      const list = grouped.get(accel) ?? []
      list.push(o)
      grouped.set(accel, list)
    }
    for (const [accel, list] of grouped) {
      if (list.length < 2) continue
      const key = `${action}:${accel}`
      byKey.set(key, { accel, action, owners: list })
    }
  }

  return [...byKey.values()].sort((a, b) =>
    a.action === b.action ? a.accel.localeCompare(b.accel) : ACTION_RANK[a.action] - ACTION_RANK[b.action],
  )
}

/** 实际会注册到系统的全局键集合（去重后的按键列表） */
export function registeredAccels(owners: HotkeyOwner[]): string[] {
  const set = new Set<string>()
  for (const o of owners) {
    for (const action of HOTKEY_ACTIONS) set.add(o.hotkeys[action])
  }
  return [...set]
}

/** 主进程注册表的入参：一个实例一行 */
export interface HotkeyBindingPayload {
  accel: string
  action: HotkeyAction
  instanceId: string
  instanceName: string
  tool: string
  scope: HotkeyScope
  /** 实例是否在跑：决定窗口没开时要不要为它拉起窗口来接收按键 */
  live: boolean
}

export interface HotkeySource {
  id: string
  name: string
  tool: string
  live: boolean
  hotkeys: HotkeyMap
}

/**
 * 把实例列表摊平成「按键 → 实例」的注册表。
 *
 * 每个实例贡献两条（暂停 / 停止），同一个按键允许出现多行 ——
 * 去重是主进程注册时做的事，这里保留全部行，冲突才有信息可查。
 */
export function expandHotkeyBindings(sources: HotkeySource[]): HotkeyBindingPayload[] {
  const out: HotkeyBindingPayload[] = []
  for (const s of sources) {
    for (const action of HOTKEY_ACTIONS) {
      const accel = s.hotkeys[action]
      if (!accel) continue
      out.push({
        accel,
        action,
        instanceId: s.id,
        instanceName: s.name,
        tool: s.tool,
        scope: s.hotkeys.scope,
        live: s.live,
      })
    }
  }
  // 排序只为让「无焦点线索时的兜底选择」可复现，不改变语义。
  // 先按动作（开始/暂停/停止），再按键名，最后按实例 id —— 这样日志与冲突清单的读法一致。
  return out.sort((a, b) => {
    if (a.action !== b.action) return ACTION_RANK[a.action] - ACTION_RANK[b.action]
    if (a.accel !== b.accel) return a.accel.localeCompare(b.accel)
    return a.instanceId.localeCompare(b.instanceId)
  })
}
