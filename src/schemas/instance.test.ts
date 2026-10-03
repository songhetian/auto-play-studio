import { describe, expect, it } from 'vitest'
import {
  ALLOWED_TRANSITIONS,
  cmpConfigSchema,
  cmdSchema,
  instanceConfigSchema,
  rpaConfigSchema,
} from '@/schemas/instance'

const baseRpa = {
  excelPath: 'C:\\tmp\\a.xlsx',
  colName: '客户名称',
  colMsg: '话术模板',
  unified: false,
  unifiedText: '',
  from: 2,
  to: 50,
  cmds: [],
}

describe('列映射校验', () => {
  it('客户名称列必填 —— 它就是搜索关键词', () => {
    const r = rpaConfigSchema.safeParse({ ...baseRpa, colName: '' })
    expect(r.success).toBe(false)
  })

  it('必须先选 Excel 文件', () => {
    expect(rpaConfigSchema.safeParse({ ...baseRpa, excelPath: '' }).success).toBe(false)
  })

  it('状态列留空也能通过 —— 由程序自动创建「执行状态」', () => {
    const r = rpaConfigSchema.safeParse({ ...baseRpa, colStatus: undefined })
    expect(r.success).toBe(true)
    expect(r.success && (r.data.colStatus ?? '')).toBe('')
  })

  it('结束行不能小于起始行', () => {
    expect(rpaConfigSchema.safeParse({ ...baseRpa, from: 10, to: 5 }).success).toBe(false)
    expect(rpaConfigSchema.safeParse({ ...baseRpa, from: 10, to: 10 }).success).toBe(true)
  })

  it('统一内容开启时可以不选消息内容列', () => {
    const r = rpaConfigSchema.safeParse({ ...baseRpa, colMsg: undefined, unified: true, unifiedText: '你好' })
    expect(r.success).toBe(true)
  })
})

describe('指令参数校验', () => {
  it('按键指令必须指定按键', () => {
    const ok = cmdSchema.safeParse({ t: '回车', type: 'key', p: '', key: { combo: ['Enter'] } })
    const bad = cmdSchema.safeParse({ t: '回车', type: 'key', p: '' })
    expect(ok.success).toBe(true)
    expect(bad.success).toBe(false)
  })

  it('图像指令必须指定一张图', () => {
    const bad = cmdSchema.safeParse({ t: '点击头像', type: 'img', p: '' })
    const ok = cmdSchema.safeParse({ t: '点击头像', type: 'img', p: '', image: { assetId: 'img_a1', threshold: 0.9 } })
    expect(bad.success).toBe(false)
    expect(ok.success).toBe(true)
  })

  it('图像指令的 assetId 必须真的指向一张素材 —— 空 id 是「还没配图」，不许存', () => {
    const empty = cmdSchema.safeParse({ t: '点击头像', type: 'img', p: '', image: { assetId: '' } })
    const picked = cmdSchema.safeParse({ t: '点击头像', type: 'img', p: '', image: { assetId: 'img_a1' } })

    expect(empty.success).toBe(false)
    expect(empty.success === false && empty.error.issues[0].message).toContain('素材')
    expect(picked.success).toBe(true)
  })

  it('强删素材会把 assetId 清空 —— 那条指令随即变成「需要重新选图」', () => {
    const after = cmdSchema.safeParse({
      t: '图像-2',
      type: 'img',
      p: '',
      image: { assetId: '', threshold: 0.85, timeoutSec: 5 },
    })
    expect(after.success).toBe(false)
  })

  it('窗口/文本指令不需要额外参数', () => {
    expect(cmdSchema.safeParse({ t: '激活窗口', type: 'win', p: '' }).success).toBe(true)
    expect(cmdSchema.safeParse({ t: '发送', type: 'text', p: '{客户名称}' }).success).toBe(true)
  })
})

describe('模板引用的列必须存在', () => {
  const withCmds = (cmds: unknown[], columns: string[]) => ({ ...baseRpa, cmds, columns })

  it('用户还没上传 Excel（也就不知道有哪些列）时不报假警', () => {
    const r = rpaConfigSchema.safeParse(withCmds([{ t: '发送', type: 'text', p: '{客户名称}' }], []))

    expect(r.success).toBe(true)
  })

  it('引用不存在的列时拦住保存，并指出是哪一列', () => {
    const r = rpaConfigSchema.safeParse(withCmds([{ t: '发送', type: 'text', p: '您好 {客户名}' }], ['客户名称']))

    expect(r.success).toBe(false)
    expect(r.success === false && r.error.issues.map((i) => i.message).join('|')).toContain('「客户名」')
  })

  it('列都在、格式化器也对，就放行', () => {
    const cmds = [
      { t: '发送', type: 'text', p: '单号 {订单编号}，金额 {金额|money}' },
      { t: '激活窗口', type: 'win', p: '微信' },
    ]

    expect(rpaConfigSchema.safeParse(withCmds(cmds, ['订单编号', '金额'])).success).toBe(true)
  })

  it('格式化器拼错也是保存时就该发现的错，不该等跑起来才炸', () => {
    const r = rpaConfigSchema.safeParse(withCmds([{ t: '发送', type: 'text', p: '{金额|meney}' }], ['金额']))

    expect(r.success).toBe(false)
    expect(r.success === false && r.error.issues[0].message).toContain('meney')
  })

  it('报错要挂在出问题的那条指令上，界面才能定位过去', () => {
    const cmds = [
      { t: '这条没问题', type: 'text', p: '{订单编号}' },
      { t: '这条有问题', type: 'text', p: '{客户名}' },
    ]

    const r = rpaConfigSchema.safeParse(withCmds(cmds, ['订单编号']))

    expect(r.success).toBe(false)
    expect(r.success === false && r.error.issues[0].path).toEqual(['cmds', 1, 'p'])
  })

  it('按键、图像指令的 p 不是模板，不参与校验', () => {
    const cmds = [
      { t: '回车', type: 'key', p: '{这不是模板}', key: { combo: ['Enter'] } },
      { t: '点击', type: 'img', p: '{这不是模板}', image: { assetId: 'img_a1' } },
    ]

    expect(rpaConfigSchema.safeParse(withCmds(cmds, ['订单编号'])).success).toBe(true)
  })

  it('关掉的指令照样校验 —— 「关掉」是暂时的开关，坏模板迟早会炸', () => {
    const cmds = [{ t: '先关着', type: 'text', on: false, p: '{客户名}' }]

    expect(rpaConfigSchema.safeParse(withCmds(cmds, ['订单编号'])).success).toBe(false)
  })
})

describe('实例配置按工具类型分流', () => {
  it('rpa 实例必须带 window 与 rpa 配置', () => {
    expect(instanceConfigSchema.safeParse({ tool: 'rpa', window: '微信', rpa: baseRpa }).success).toBe(true)
    expect(instanceConfigSchema.safeParse({ tool: 'rpa', rpa: baseRpa }).success).toBe(false)
  })

  it('logi 实例不接受 rpa 字段', () => {
    const bad = instanceConfigSchema.safeParse({
      tool: 'logi',
      logi: { file: 'a.xlsx', colWaybill: '物流单号', provider: 'excel' },
      rpa: baseRpa,
    })
    // discriminated union 只认自己那一支，多余字段被忽略而非误判为 rpa
    expect(bad.success).toBe(true)
    expect(bad.success && bad.data.tool).toBe('logi')
  })

  it('未知工具类型被拒绝', () => {
    expect(instanceConfigSchema.safeParse({ tool: 'unknown' }).success).toBe(false)
  })
})

describe('Excel 对比配置', () => {
  const fields = (...roles: Array<'key' | 'compare'>) =>
    roles.map((role, i) => ({ name: `列${i}`, role, type: 'text' as const }))

  it('还没上传文件时可以通过（字段列表为空）', () => {
    expect(cmpConfigSchema.safeParse({}).success).toBe(true)
  })

  it('上传了字段却一个主键都没指定 → 拒绝', () => {
    const r = cmpConfigSchema.safeParse({ primaryFields: fields('compare', 'compare') })
    expect(r.success).toBe(false)
    expect(r.success === false && r.error.issues[0].message).toContain('主键')
  })

  it('指定了主键就能通过', () => {
    expect(cmpConfigSchema.safeParse({ primaryFields: fields('key', 'compare') }).success).toBe(true)
  })

  it('容差不能是负数', () => {
    expect(cmpConfigSchema.safeParse({ tolerance: -1 }).success).toBe(false)
    expect(cmpConfigSchema.safeParse({ tolerance: 0.01 }).success).toBe(true)
  })

  it('对比表映射可以留空（表示该字段不比对）', () => {
    const r = cmpConfigSchema.safeParse({ maps: { '后台.xlsx': { 订单号: '订单编号', 金额: null } } })
    expect(r.success).toBe(true)
  })
})

describe('状态机迁移表', () => {
  it('空闲只能走向开始/待命/错误', () => {
    expect(ALLOWED_TRANSITIONS.idle).toEqual(expect.arrayContaining(['starting']))
    expect(ALLOWED_TRANSITIONS.idle).not.toContain('running')
  })

  it('跑完之后只有重新开始一条路', () => {
    expect(ALLOWED_TRANSITIONS.completed).toEqual(['idle'])
  })
})

describe('实例级快捷键', () => {
  const rpa = { tool: 'rpa' as const, window: '微信', rpa: baseRpa }
  const DEFAULTS = { run: 'F8', toggle: 'F9', stop: 'F10', scope: 'window' }

  it('老配置没有 hotkeys 字段时补上默认值（含开始键 F8），不需要数据迁移', () => {
    const r = instanceConfigSchema.parse(rpa)
    expect(r.hotkeys).toEqual(DEFAULTS)
  })

  it('四个工具都在同一层读同一个字段，不藏在工具子对象里', () => {
    const cases = [
      rpa,
      { tool: 'logi' as const, logi: { file: 'a.xlsx', colWaybill: '单号' } },
      { tool: 'cmp' as const, cmp: {} },
      { tool: 'monitor' as const, region: 'full', rules: [] },
    ]
    for (const c of cases) {
      const r = instanceConfigSchema.parse(c)
      expect(r.hotkeys.run).toBe('F8')
      expect(r.hotkeys.toggle).toBe('F9')
      // 工具子对象里不应该再出现 hotkeys，否则读取方得知道四种嵌套路径
      const inner = (r as Record<string, unknown>)[c.tool]
      expect(typeof inner === 'object' && inner !== null && 'hotkeys' in (inner as object)).toBe(false)
    }
  })

  it('只给一半字段时其余取默认值，避免半残的热键配置', () => {
    const r = instanceConfigSchema.parse({ ...rpa, hotkeys: { toggle: 'F7' } })
    expect(r.hotkeys).toEqual({ ...DEFAULTS, toggle: 'F7' })
  })

  it('作用范围只接受 window / tool', () => {
    expect(instanceConfigSchema.safeParse({ ...rpa, hotkeys: { scope: 'all' } }).success).toBe(false)
    expect(instanceConfigSchema.safeParse({ ...rpa, hotkeys: { scope: 'tool' } }).success).toBe(true)
  })

  it('同一个实例的两个动作不能共用同一个键', () => {
    // 跨实例共用是有意允许的（主进程按确定性规则挑一个）；
    // 但同一个实例内部共用就成了「按下去谁响应看数组顺序」—— 那是随机行为，必须拦。
    const bad = instanceConfigSchema.safeParse({ ...rpa, hotkeys: { run: 'F8', toggle: 'F8', stop: 'F10' } })
    expect(bad.success).toBe(false)
    expect(!bad.success && bad.error.issues[0].message).toContain('重复')
  })

  it('判重前先归一化，否则 f8 与 F8 会溜过去', () => {
    const bad = instanceConfigSchema.safeParse({ ...rpa, hotkeys: { run: 'f8', toggle: 'F8', stop: 'F10' } })
    expect(bad.success).toBe(false)
  })

  it('认不出来的键不参与判重，交给拾取器单独报「不知道这个键」', () => {
    // 否则一条烂配置会同时报两条错，用户不知道该先改哪个
    const r = instanceConfigSchema.safeParse({ ...rpa, hotkeys: { run: '乱写', toggle: 'F9', stop: 'F10' } })
    expect(r.success).toBe(true)
  })
})
