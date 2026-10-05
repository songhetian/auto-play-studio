import { describe, expect, it } from 'vitest'
import { normalizeInstance, normalizeInstances } from '@/lib/instanceNormalize'
import type { Instance } from '@/schemas/instance'

/**
 * 夹具直接照抄引擎 `DEFAULT_CONFIG` 的真实形状（见 python/engine/main.py）：
 * 老记录里没有 columns / hotkeys，这正是线上把配置页搞白屏的那份数据。
 */
const engineRpa = {
  id: 'R1',
  name: '演示-rpa',
  tool: 'rpa',
  status: 'idle',
  done: 0,
  total: 0,
  updatedAt: 0,
  config: {
    tool: 'rpa',
    window: '',
    rpa: {
      excelPath: '',
      colName: '客户名称',
      colMsg: '',
      colStatus: '',
      unified: false,
      unifiedText: '',
      from: 2,
      to: 2,
      retry: 2,
      onFail: 'continue',
      skipSuccess: true,
      writeReason: true,
      backup: true,
      cmds: [],
    },
  },
} as unknown as Instance

describe('实例读模型归一化', () => {
  it('老记录缺 columns 时补成空数组，前端读 .length 不再炸', () => {
    const n = normalizeInstance(engineRpa)
    expect(n.config.tool === 'rpa' && n.config.rpa.columns).toEqual([])
  })

  it('老记录缺 hotkeys 时补成默认键，且写在实例级', () => {
    const n = normalizeInstance(engineRpa)
    expect(n.config.hotkeys).toEqual({ run: 'F8', toggle: 'F9', stop: 'F10', scope: 'window' })
    // 工具子对象里不该出现它，否则又是一条要记住的嵌套路径
    expect(n.config.tool === 'rpa' && 'hotkeys' in n.config.rpa).toBe(false)
  })

  it('用户已经改过热键时保留原值，只补缺失的那一项', () => {
    const n = normalizeInstance({
      ...engineRpa,
      config: { ...engineRpa.config, hotkeys: { toggle: 'F7', scope: 'tool' } },
    })
    expect(n.config.hotkeys).toEqual({ run: 'F8', toggle: 'F7', stop: 'F10', scope: 'tool' })
  })

  it('四个工具都能收拾，且不改动已有字段', () => {
    const logi = normalizeInstance({
      id: 'L1',
      name: 'l',
      tool: 'logi',
      status: 'idle',
      done: 0,
      total: 0,
      updatedAt: 0,
      config: { tool: 'logi', logi: { file: 'a.xlsx', colWaybill: '物流单号' } },
    } as unknown as Instance)
    expect(logi.config.tool === 'logi' && logi.config.logi.columns).toEqual([])
    expect(logi.config.tool === 'logi' && logi.config.logi.file).toBe('a.xlsx')

    const cmp = normalizeInstance({
      id: 'C1',
      name: 'c',
      tool: 'cmp',
      status: 'idle',
      done: 0,
      total: 0,
      updatedAt: 0,
      config: { tool: 'cmp', cmp: { primaryFile: '' } },
    } as unknown as Instance)
    expect(cmp.config.tool === 'cmp' && cmp.config.cmp.primaryFields).toEqual([])

    const monitor = normalizeInstance({
      id: 'M1',
      name: 'm',
      tool: 'monitor',
      status: 'idle',
      done: 0,
      total: 0,
      updatedAt: 0,
      config: { tool: 'monitor', region: 'full', rules: [{ assetId: 'A1', threshold: 0.9 }] },
    } as unknown as Instance)
    expect(monitor.config.tool === 'monitor' && monitor.config.rules).toHaveLength(1)
  })

  it('列表接口对非数组输入返回空列表，而不是把页面搞崩', () => {
    expect(normalizeInstances(null)).toEqual([])
    expect(normalizeInstances({ detail: 'boom' })).toEqual([])
    expect(normalizeInstances([engineRpa])).toHaveLength(1)
  })

  it('guard 实例补齐 guard 段与 hotkeys —— 老存档没有这两段，配置页读 guard.levels 会白屏', () => {
    const guard = normalizeInstance({
      id: 'G1',
      name: '敏感词监控',
      tool: 'guard',
      status: 'idle',
      done: 0,
      total: 0,
      updatedAt: 0,
      config: { tool: 'guard', window: '千牛' },
    } as unknown as Instance)

    const cfg = guard.config
    if (cfg.tool !== 'guard') throw new Error('工具类型应保持 guard')
    expect(cfg.guard.captureMode).toBe('auto')
    expect(cfg.guard.levels).toEqual(['high', 'mid', 'low'])
    expect(cfg.hotkeys.run).toBe('F8')
  })
})
