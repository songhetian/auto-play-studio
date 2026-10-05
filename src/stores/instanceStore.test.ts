import { beforeEach, describe, expect, it } from 'vitest'
import { useInstanceStore } from '@/stores/instanceStore'
import { DEFAULT_HOTKEYS } from '@/schemas/instance'
import type { Instance } from '@/schemas/instance'

const rpaInstance = (id: string): Instance => ({
  id,
  name: '测试实例',
  tool: 'rpa',
  status: 'idle',
  done: 0,
  total: 0,
  updatedAt: 0,
  config: {
    tool: 'rpa',
    window: '微信',
    rpa: {
      excelPath: 'C:\\a.xlsx',
      colName: '客户名称',
      colMsg: '话术模板',
      colStatus: '',
      unified: false,
      unifiedText: '',
      from: 2,
      to: 50,
      retry: 2,
      onFail: 'continue',
      sendIntervalMs: 500,
      skipSuccess: true,
      writeReason: true,
      backup: true,
      cmds: [{ t: '激活窗口', type: 'win', on: true, p: '' }],
      columns: ['客户名称', '话术模板'],
    },
    hotkeys: DEFAULT_HOTKEYS,
  },
})

const macroInstance = (id: string): Instance => ({
  id,
  name: '按键精灵',
  tool: 'macro',
  status: 'idle',
  done: 0,
  total: 0,
  updatedAt: 0,
  config: {
    tool: 'macro',
    window: '记事本',
    macro: {
      cmds: [{ t: '复制', type: 'key', on: true, p: '', key: { combo: ['ctrl', 'c'], delayMs: 120, repeat: 1 } }],
    },
    hotkeys: DEFAULT_HOTKEYS,
  },
})

const reset = () => useInstanceStore.setState({ instances: {}, activeId: null })

describe('状态机守卫', () => {
  beforeEach(reset)

  it('合法迁移被接受并更新状态', () => {
    const s = useInstanceStore.getState()
    s.upsert(rpaInstance('R1'))
    expect(s.transition('R1', 'starting')).toBe(true)
    expect(useInstanceStore.getState().instances.R1.status).toBe('starting')
  })

  it('非法迁移被拒绝且状态不变', () => {
    const s = useInstanceStore.getState()
    s.upsert(rpaInstance('R1'))
    expect(s.transition('R1', 'running')).toBe(false)
    expect(useInstanceStore.getState().instances.R1.status).toBe('idle')
  })

  it('对不存在的实例迁移直接返回 false', () => {
    expect(useInstanceStore.getState().transition('NOPE', 'starting')).toBe(false)
  })
})

describe('配置修改', () => {
  beforeEach(reset)

  it('只改客户名称列时不会丢掉流程指令与其它字段', () => {
    const s = useInstanceStore.getState()
    s.upsert(rpaInstance('R1'))

    s.patchConfig('R1', { rpa: { colName: '收货人' } })
    const cfg = useInstanceStore.getState().instances.R1.config
    expect(cfg.tool === 'rpa' && cfg.rpa.colName).toBe('收货人')
    expect(cfg.tool === 'rpa' && cfg.rpa.cmds).toHaveLength(1)
    expect(cfg.tool === 'rpa' && cfg.rpa.excelPath).toBe('C:\\a.xlsx')
  })

  it('patchConfig 是浅合并：只传 rpa 时 window 不应被清空', () => {
    const s = useInstanceStore.getState()
    s.upsert(rpaInstance('R1'))
    s.patchConfig('R1', { window: '企业微信' } as any)
    const cfg = useInstanceStore.getState().instances.R1.config
    expect(cfg.tool === 'rpa' && cfg.window).toBe('企业微信')
    expect(cfg.tool === 'rpa' && cfg.rpa.excelPath).toBe('C:\\a.xlsx')
  })

  it('setCmds 只认「有指令序列」的工具：rpa 与 macro，其余工具一字不动', () => {
    const s = useInstanceStore.getState()
    s.upsert(rpaInstance('R1'))
    s.upsert({
      ...rpaInstance('L1'),
      tool: 'logi',
      config: {
        tool: 'logi',
        logi: {
          file: 'a.xlsx',
          colWaybill: '物流单号',
          provider: 'excel',
          apiKey: '',
          customer: '',
          retry: 2,
          intervalMs: 1500,
          pauseOnCaptcha: true,
          columns: ['物流单号'],
        },
        hotkeys: DEFAULT_HOTKEYS,
      },
    })

    s.setCmds('R1', [{ t: '输入', type: 'text', on: true, p: 'x' }])
    expect((useInstanceStore.getState().instances.R1.config as any).rpa.cmds).toHaveLength(1)

    // 物流没有指令序列：调用应当彻底无副作用，而不是把 cmds 挂到配置根上
    const before = useInstanceStore.getState().instances.L1.config
    s.setCmds('L1', [{ t: '输入', type: 'text', on: true, p: 'x' }])
    expect(useInstanceStore.getState().instances.L1.config).toBe(before)
  })

  it('macro 实例的指令序列走 config.macro.cmds，不是 config.rpa.cmds', () => {
    const s = useInstanceStore.getState()
    s.upsert(macroInstance('M1'))

    s.setCmds('M1', [
      { t: '输入问候语', type: 'text', on: true, p: '您好' },
      { t: '复制', type: 'key', on: true, p: '', key: { combo: ['ctrl', 'c'], delayMs: 120, repeat: 1 } },
    ])
    const cfg = useInstanceStore.getState().instances.M1.config as any
    expect(cfg.macro.cmds).toHaveLength(2)
    expect(cfg.rpa).toBeUndefined()

    s.patchCmd('M1', 1, { key: { combo: ['ctrl', 'enter'], delayMs: 50, repeat: 1 } })
    const cmds = (useInstanceStore.getState().instances.M1.config as any).macro.cmds
    expect(cmds[1].key.combo).toEqual(['ctrl', 'enter'])
    expect(cmds[0].p).toBe('您好')
  })

  it('patchCmd 只改选中的那一条指令', () => {
    const s = useInstanceStore.getState()
    s.upsert(rpaInstance('R1'))
    s.setCmds('R1', [
      { t: '激活窗口', type: 'win', on: true, p: '微信' },
      { t: '输入文本', type: 'text', on: true, p: '原文' },
    ])

    s.patchCmd('R1', 1, { p: '您好 {客户名称}' })

    const cmds = (useInstanceStore.getState().instances.R1.config as any).rpa.cmds
    expect(cmds[1].p).toBe('您好 {客户名称}')
    expect(cmds[0]).toEqual({ t: '激活窗口', type: 'win', on: true, p: '微信' })
  })

  it('patchCmd 能改动深层参数（按键组合、图像阈值）', () => {
    const s = useInstanceStore.getState()
    s.upsert(rpaInstance('R1'))
    s.setCmds('R1', [
      { t: '回车', type: 'key', on: true, p: '', key: { combo: ['Enter'], delayMs: 120, repeat: 1 } },
      { t: '点击发送', type: 'img', on: true, p: '', image: { threshold: 0.85, timeoutSec: 5, offsetX: 0, offsetY: 0, onMiss: 'fail' } },
    ])

    s.patchCmd('R1', 0, { key: { combo: ['Ctrl', 'Enter'], delayMs: 50, repeat: 2 } })
    s.patchCmd('R1', 1, { image: { assetId: 'btn_send', threshold: 0.9, timeoutSec: 8, offsetX: 2, offsetY: -3, onMiss: 'retry' } })

    const cmds = (useInstanceStore.getState().instances.R1.config as any).rpa.cmds
    expect(cmds[0].key.combo).toEqual(['Ctrl', 'Enter'])
    expect(cmds[0].key.repeat).toBe(2)
    expect(cmds[1].image.assetId).toBe('btn_send')
    expect(cmds[1].image.onMiss).toBe('retry')
  })

  it('patchCmd 越界或非 rpa 实例时静默忽略', () => {
    const s = useInstanceStore.getState()
    s.upsert(rpaInstance('R1'))
    s.setCmds('R1', [{ t: '激活窗口', type: 'win', on: true, p: '' }])

    expect(() => s.patchCmd('R1', 99, { p: 'x' })).not.toThrow()
    expect(() => s.patchCmd('NOPE', 0, { p: 'x' })).not.toThrow()
    expect((useInstanceStore.getState().instances.R1.config as any).rpa.cmds[0].p).toBe('')
  })

  it('不存在的实例上修改配置不应抛错', () => {
    expect(() => useInstanceStore.getState().patchConfig('NOPE', {} as any)).not.toThrow()
    expect(() => useInstanceStore.getState().setCmds('NOPE', [])).not.toThrow()
  })

  it('非法 patch 被拒写：类型不对的值不会进 store', () => {
    const s = useInstanceStore.getState()
    s.upsert(rpaInstance('R1'))
    const before = useInstanceStore.getState().instances.R1

    // 数字输入框给字符串是很常见的一类脏数据：存进去要等到执行时才炸
    s.patchConfig('R1', { rpa: { from: '3' } } as any)

    expect(useInstanceStore.getState().instances.R1).toBe(before)
  })

  it('非法 patch 被拒写：混进别的工具的字段', () => {
    const s = useInstanceStore.getState()
    s.upsert(rpaInstance('R1'))

    // 拿错实例 id 就会写成这样：rpa 实例收到 logi 的 patch
    s.patchConfig('R1', { logi: { file: 'a.xlsx' } } as any)
    expect((useInstanceStore.getState().instances.R1.config as any).logi).toBeUndefined()

    s.patchConfig('R1', { windwo: '微信' } as any)
    expect((useInstanceStore.getState().instances.R1.config as any).windwo).toBeUndefined()
  })

  it('跨字段规则不在这里拦：行区间暂时填反仍然写得进去', () => {
    const s = useInstanceStore.getState()
    s.upsert(rpaInstance('R1'))

    // to < from 由配置页的字段级校验提示并禁用保存，不该在写入点冻结输入框
    s.patchConfig('R1', { rpa: { from: 10, to: 2 } })

    const cfg = useInstanceStore.getState().instances.R1.config as any
    expect(cfg.rpa.from).toBe(10)
    expect(cfg.rpa.to).toBe(2)
  })
})

describe('实例列表', () => {
  beforeEach(reset)

  it('首次加载列表会自动选中第一个实例', () => {
    useInstanceStore.getState().setInstances([rpaInstance('R1'), rpaInstance('R2')])
    expect(useInstanceStore.getState().activeId).toBe('R1')
  })

  it('删除当前选中实例后不再指向它', () => {
    const s = useInstanceStore.getState()
    s.setInstances([rpaInstance('R1')])
    s.setActive('R1')
    s.remove('R1')
    expect(useInstanceStore.getState().activeId).toBeNull()
    expect(useInstanceStore.getState().instances.R1).toBeUndefined()
  })
})
