import { describe, expect, it } from 'vitest'
import { buildRunConfirm } from '@/lib/runGuard'
import type { Instance } from '@/schemas/instance'

const rpaInst = (over: Record<string, unknown> = {}): Instance =>
  ({
    id: 'R1',
    name: '群发',
    tool: 'rpa',
    status: 'idle',
    done: 0,
    total: 0,
    updatedAt: 0,
    config: {
      tool: 'rpa',
      window: '微信',
      rpa: {
        excelPath: 'a.xlsx',
        colName: '客户名称',
        colMsg: '',
        colStatus: '',
        unified: false,
        unifiedText: '',
        from: 2,
        to: 11,
        retry: 2,
        onFail: 'continue',
        sendIntervalMs: 500,
        skipSuccess: true,
        writeReason: true,
        backup: true,
        cmds: [],
        columns: [],
      },
      hotkeys: { run: 'F8', toggle: 'F9', stop: 'F10', scope: 'window' },
      ...over,
    },
  }) as unknown as Instance

const macroInst = (cmds: unknown[] = [{ t: '回车', type: 'key', p: '', key: { combo: ['Enter'] } }]): Instance =>
  ({
    id: 'M1',
    name: '宏',
    tool: 'macro',
    status: 'idle',
    done: 0,
    total: 0,
    updatedAt: 0,
    config: {
      tool: 'macro',
      window: '记事本',
      macro: { cmds },
      hotkeys: { run: 'F8', toggle: 'F9', stop: 'F10', scope: 'window' },
    },
  }) as unknown as Instance

describe('执行前确认文案', () => {
  it('rpa：说明会动哪个窗口、处理多少行', () => {
    const c = buildRunConfirm(rpaInst())
    expect(c).not.toBeNull()
    expect(c!.title).toContain('开始执行')
    expect(c!.desc).toContain('微信')
    // from=2, to=11 → 10 行
    expect(c!.desc).toContain('10 行')
    expect(c!.confirmText).toBe('开始执行')
  })

  it('rpa：行数按 from/to 计算，from>to 时归零不报负数', () => {
    const c = buildRunConfirm(rpaInst({ rpa: { from: 5, to: 3 } } as never))
    expect(c).not.toBeNull()
    expect(c!.desc).toContain('0 行')
  })

  it('rpa：未绑定窗口时显式提示，而不是悄悄发到前台窗口', () => {
    const c = buildRunConfirm(rpaInst({ window: '' } as never))
    expect(c!.desc).toContain('未绑定窗口')
  })

  it('macro：说明会执行多少条指令', () => {
    const c = buildRunConfirm(macroInst([1, 2, 3].map(() => ({ t: 'x', type: 'key', p: '', key: { combo: ['Enter'] } }))))
    expect(c).not.toBeNull()
    expect(c!.title).toContain('执行一次')
    expect(c!.desc).toContain('3 条指令')
    expect(c!.desc).toContain('记事本')
    expect(c!.confirmText).toBe('执行一次')
  })

  it('monitor / logi / cmp 不碰键鼠，无需这道确认', () => {
    for (const tool of ['monitor', 'logi', 'cmp'] as const) {
      const inst = {
        id: 'x',
        name: 'x',
        tool,
        status: 'idle',
        done: 0,
        total: 0,
        updatedAt: 0,
        config: { tool, hotkeys: { run: 'F8', toggle: 'F9', stop: 'F10', scope: 'window' } },
      } as unknown as Instance
      expect(buildRunConfirm(inst)).toBeNull()
    }
  })
})
