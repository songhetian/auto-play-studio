import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOTKEY_MAP,
  accelFromEvent,
  expandHotkeyBindings,
  findHotkeyConflicts,
  formatAccel,
  hotkeyMapOf,
  matchesAccel,
  normalizeAccel,
  normalizeKey,
  registeredAccels,
  validateGlobalAccel,
} from '@/lib/hotkey'
import type { HotkeyOwner } from '@/lib/hotkey'

const owner = (id: string, toggle: string, stop = 'F10', tool = 'rpa', run = 'F8'): HotkeyOwner => ({
  id,
  name: id,
  tool,
  hotkeys: { run, toggle, stop, scope: 'window' },
})

describe('按键规范化', () => {
  it('功能键统一成大写', () => {
    expect(normalizeKey('f9')).toBe('F9')
    expect(normalizeKey('F10')).toBe('F10')
    expect(normalizeKey('F24')).toBe('F24')
  })

  it('字母数字统一成大写，符号按 accelerator 写法', () => {
    expect(normalizeKey('s')).toBe('S')
    expect(normalizeKey('7')).toBe('7')
    expect(normalizeKey(' ')).toBe('Space')
    expect(normalizeKey('ArrowUp')).toBe('Up')
    expect(normalizeKey('/')).toBe('/')
  })

  it('认不出来的按键返回 null，不要瞎猜', () => {
    expect(normalizeKey('F25')).toBeNull()
    expect(normalizeKey('LaunchMail')).toBeNull()
    expect(normalizeKey('')).toBeNull()
  })

  it('修饰键顺序固定，两种写法得到同一个串', () => {
    expect(normalizeAccel('ctrl+shift+s')).toBe('CommandOrControl+Shift+S')
    expect(normalizeAccel('Shift+Ctrl+S')).toBe('CommandOrControl+Shift+S')
  })

  it('ctrl 与 win 是两个不同的键位，不能合并', () => {
    expect(normalizeAccel('ctrl+s')).toBe('CommandOrControl+S')
    expect(normalizeAccel('win+s')).toBe('Super+S')
  })

  it('没有主键时返回 null', () => {
    expect(normalizeAccel('ctrl')).toBeNull()
    expect(normalizeAccel('')).toBeNull()
    expect(normalizeAccel(undefined)).toBeNull()
  })
})

describe('全局快捷键的安全底线', () => {
  it('功能键可以直接当全局键', () => {
    expect(validateGlobalAccel('F9').ok).toBe(true)
    expect(validateGlobalAccel('F12').ok).toBe(true)
  })

  it('单字母不允许：会把全系统的这个键吃掉', () => {
    const r = validateGlobalAccel('S')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('功能键')
  })

  it('带修饰键的字母组合允许', () => {
    expect(validateGlobalAccel('CommandOrControl+Shift+P').ok).toBe(true)
  })
})

describe('从键盘事件录制按键', () => {
  const ev = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  })

  it('裸功能键', () => {
    expect(accelFromEvent(ev('F9'))).toBe('F9')
  })

  it('Ctrl+S 记成跨平台写法', () => {
    expect(accelFromEvent(ev('s', { ctrlKey: true }))).toBe('CommandOrControl+S')
  })

  it('只按修饰键时不给结果（还在录键中）', () => {
    expect(accelFromEvent(ev('Control', { ctrlKey: true }))).toBeNull()
    expect(accelFromEvent(ev('Shift', { shiftKey: true }))).toBeNull()
  })

  it('功能键也可以带修饰键', () => {
    expect(accelFromEvent(ev('F9', { shiftKey: true }))).toBe('Shift+F9')
    expect(accelFromEvent(ev('F9', { ctrlKey: true }))).toBe('CommandOrControl+F9')
  })
})

describe('展示与命中', () => {
  it('展示按 Windows 习惯翻译修饰键', () => {
    expect(formatAccel('CommandOrControl+Shift+P')).toBe('Ctrl + Shift + P')
    expect(formatAccel('F9')).toBe('F9')
  })

  it('窗口内快捷键按事件命中', () => {
    const e = { key: 's', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
    expect(matchesAccel('CommandOrControl+S', e)).toBe(true)
    expect(matchesAccel('CommandOrControl+P', e)).toBe(false)
  })
})

describe('从配置读热键', () => {
  it('没有 hotkeys 字段时给默认值（老实例不用迁移）', () => {
    expect(hotkeyMapOf({ tool: 'rpa', rpa: {} })).toEqual(DEFAULT_HOTKEY_MAP)
    expect(hotkeyMapOf(null)).toEqual(DEFAULT_HOTKEY_MAP)
  })

  it('用户改过的值被读出来并规范化', () => {
    expect(hotkeyMapOf({ hotkeys: { run: 'ctrl+alt+r', toggle: 'f8', stop: 'ctrl+alt+q', scope: 'tool' } })).toEqual({
      run: 'CommandOrControl+Alt+R',
      toggle: 'F8',
      stop: 'CommandOrControl+Alt+Q',
      scope: 'tool',
    })
  })

  it('坏值单项回落，不影响另一项', () => {
    expect(hotkeyMapOf({ hotkeys: { toggle: '不是按键', stop: 'F11' } })).toEqual({
      run: 'F8',
      toggle: 'F9',
      stop: 'F11',
      scope: 'window',
    })
  })
})

describe('冲突检测', () => {
  it('入参必须先规范化：本函数只做比较，不二次解析', () => {
    // 组装 owners 前统一走 hotkeyMapOf()；否则 'f9' 与 'F9' 会被当成两个键而漏报冲突。
    // run 特意给成不同的值，免得它在旁边造出一条与本事无关的冲突。
    const c = findHotkeyConflicts([
      owner('a', 'f9', 'F1', 'rpa', 'F3'),
      owner('b', 'F9', 'F2', 'rpa', 'F4'),
    ])
    expect(c).toEqual([])
  })

  it('多实例共用 F9 会报冲突，并列出全部占用者', () => {
    // 每个实例的 run 给成不同的键：这条测的是 toggle 的冲突，别让 run 在旁边多报一条
    const owners = [
      owner('a', 'F9', 'F1', 'rpa', 'F5'),
      owner('b', 'F9', 'F2', 'rpa', 'F6'),
      owner('c', 'F7', 'F3', 'rpa', 'F4'),
    ]
    const c = findHotkeyConflicts(owners)
    expect(c).toHaveLength(1)
    expect(c[0].action).toBe('toggle')
    expect(c[0].accel).toBe('F9')
    expect(c[0].owners.map((o) => o.id)).toEqual(['a', 'b'])
  })

  it('暂停键和停止键不同动作，共用同一个键也只算各自一条', () => {
    const owners: HotkeyOwner[] = [
      { id: 'a', name: 'a', tool: 'rpa', hotkeys: { run: 'F8', toggle: 'F9', stop: 'F9', scope: 'window' } },
      { id: 'b', name: 'b', tool: 'rpa', hotkeys: { run: 'F8', toggle: 'F9', stop: 'F10', scope: 'window' } },
    ]
    const c = findHotkeyConflicts(owners)
    expect(c.map((x) => x.action)).toEqual(['run', 'toggle'])
  })

  it('没有冲突时返回空数组', () => {
    expect(findHotkeyConflicts([owner('a', 'F9', 'F1', 'rpa', 'F3'), owner('b', 'F8', 'F2', 'rpa', 'F4')])).toEqual([])
  })

  it('冲突按「开始 → 暂停 → 停止」排，与界面上的顺序一致', () => {
    const owners: HotkeyOwner[] = [
      { id: 'a', name: 'a', tool: 'macro', hotkeys: { run: 'F8', toggle: 'F9', stop: 'F10', scope: 'window' } },
      { id: 'b', name: 'b', tool: 'macro', hotkeys: { run: 'F8', toggle: 'F9', stop: 'F10', scope: 'window' } },
    ]
    expect(findHotkeyConflicts(owners).map((x) => x.action)).toEqual(['run', 'toggle', 'stop'])
  })
})

describe('run（开始执行）：每实例的第三个动作', () => {
  it('默认 F8，和暂停 / 停止不撞', () => {
    expect(DEFAULT_HOTKEY_MAP).toEqual({ run: 'F8', toggle: 'F9', stop: 'F10', scope: 'window' })
  })

  it('老配置里没有 run 这一项，逐项回落到默认值（不迁移存档）', () => {
    expect(hotkeyMapOf({ hotkeys: { toggle: 'F1', stop: 'F2', scope: 'tool' } })).toEqual({
      run: 'F8',
      toggle: 'F1',
      stop: 'F2',
      scope: 'tool',
    })
  })

  it('三个动作各自独立回落，坏一项不牵连其它', () => {
    expect(hotkeyMapOf({ hotkeys: { run: 'ctrl+alt+r', toggle: '不是按键', stop: 'F2' } })).toEqual({
      run: 'CommandOrControl+Alt+R',
      toggle: 'F9',
      stop: 'F2',
      scope: 'window',
    })
  })
})

describe('实际注册的全局键', () => {
  it('相同的键只注册一次，不重复注册', () => {
    expect(registeredAccels([owner('a', 'F9'), owner('b', 'F9')])).toEqual(['F8', 'F9', 'F10'])
  })

  it('不同实例用不同键时全部注册', () => {
    expect(registeredAccels([owner('a', 'F8', 'F12'), owner('b', 'F9', 'F11')])).toEqual(['F8', 'F12', 'F9', 'F11'])
  })
})

describe('摊平成主进程的注册表', () => {
  const src = (id: string, toggle: string, stop: string, live = false, tool = 'rpa', run = 'F8') => ({
    id,
    name: id,
    tool,
    live,
    hotkeys: { run, toggle, stop, scope: 'window' as const },
  })

  it('一个实例贡献三条：开始 / 暂停 / 停止', () => {
    const b = expandHotkeyBindings([src('M1', 'F9', 'F10', true)])
    expect(b.map((x) => `${x.action}=${x.accel}`)).toEqual(['run=F8', 'toggle=F9', 'stop=F10'])
  })

  it('重复按键保留两行，冲突信息才不丢', () => {
    const b = expandHotkeyBindings([src('M1', 'F9', 'F10'), src('M2', 'F9', 'F10')])
    expect(b.filter((x) => x.accel === 'F9')).toHaveLength(2)
    expect(b.filter((x) => x.accel === 'F9').map((x) => x.instanceId)).toEqual(['M1', 'M2'])
  })

  it('live 与 scope 原样带过去，主进程据此决定要不要拉窗口', () => {
    const b = expandHotkeyBindings([
      { ...src('M1', 'F9', 'F10', true), hotkeys: { run: 'F8', toggle: 'F9', stop: 'F10', scope: 'tool' } },
    ])
    expect(b[0]).toMatchObject({ live: true, scope: 'tool', instanceName: 'M1' })
  })
})
