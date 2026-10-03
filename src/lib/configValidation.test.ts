import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { hasErrors, zodFieldErrors } from '@/lib/configValidation'
import { rpaConfigSchema } from '@/schemas/instance'

/** 用一个最小 schema 验证「路径 → 消息」的摊平规则，期望消息就是 schema 里写死的那句 */
const demo = z
  .object({
    name: z.string().min(1, '名称不能为空'),
    rows: z.array(z.number()),
  })
  .refine((v) => v.rows.length <= 3, { message: '最多三行', path: ['rows'] })

describe('字段级校验', () => {
  it('通过时返回空对象', () => {
    expect(zodFieldErrors(demo, { name: 'a', rows: [1] })).toEqual({})
    expect(hasErrors({})).toBe(false)
  })

  it('错误按字段路径归类，消息取自 schema 自己写的文案', () => {
    expect(zodFieldErrors(demo, { name: '', rows: [] })).toEqual({ name: '名称不能为空' })
    expect(zodFieldErrors(demo, { name: 'a', rows: [1, 2, 3, 4] })).toEqual({ rows: '最多三行' })
  })

  it('同字段多条错误只留第一条', () => {
    const two = z.string().min(3, '太短').regex(/^\d+$/, '只能是数字')
    expect(zodFieldErrors(two, 'ab')).toEqual({ '': '太短' })
  })
})

describe('RPA 配置的字段级校验', () => {
  const base = {
    excelPath: '',
    colName: '',
    colMsg: '',
    colStatus: '',
    unified: false,
    unifiedText: '',
    from: 2,
    to: 5,
    retry: 2,
    onFail: 'continue' as const,
    skipSuccess: true,
    writeReason: true,
    backup: true,
    cmds: [],
    columns: [],
  }

  it('空表路径与空关键词列被标出来', () => {
    const errs = zodFieldErrors(rpaConfigSchema, base)
    expect(errs.excelPath).toBeTruthy()
    expect(errs.colName).toBeTruthy()
  })

  it('结束行小于起始行被标出来（跨字段规则）', () => {
    const errs = zodFieldErrors(rpaConfigSchema, { ...base, excelPath: 'a.xlsx', colName: '客户', to: 1, from: 5 })
    expect(errs.to).toBe('结束行不能小于起始行')
  })

  it('填齐后没有错误', () => {
    expect(zodFieldErrors(rpaConfigSchema, { ...base, excelPath: 'a.xlsx', colName: '客户名字' })).toEqual({})
  })
})

describe('按键指令的键名白名单', () => {
  const base = {
    excelPath: 'a.xlsx',
    colName: '客户',
    from: 2,
    to: 5,
    cmds: [],
    columns: [],
  }
  const keyCmd = (combo: string[]) => ({
    ...base,
    cmds: [{ t: '粘贴', type: 'key' as const, on: true, p: '', key: { combo, delayMs: 120, repeat: 1 } }],
  })

  it('写法不统一但认得出来的键名放行（归一化交给引擎）', () => {
    expect(zodFieldErrors(rpaConfigSchema, keyCmd(['Ctrl', 'V']))).toEqual({})
    expect(zodFieldErrors(rpaConfigSchema, keyCmd(['CTRL', 'shift', 'c']))).toEqual({})
  })

  it('编出来的键名在保存时就被拦住，不留给运行期', () => {
    const errs = zodFieldErrors(rpaConfigSchema, keyCmd(['Ctr', 'C']))
    expect(Object.values(errs).join()).toContain('Ctr')
  })

  it('只按住修饰键的组合同样拦住（运行时会静默什么都不按）', () => {
    const errs = zodFieldErrors(rpaConfigSchema, keyCmd(['Ctrl', 'Shift']))
    expect(Object.values(errs).join()).toContain('还缺一个按键')
  })
})

describe('zod 兜底文案必须翻成中文', () => {
  it('min(1) 的自带文案不再泄漏成英文', () => {
    const errs = zodFieldErrors(rpaConfigSchema, {
      excelPath: '',
      colName: '客户',
      from: 2,
      to: 5,
      cmds: [],
    })
    expect(errs.excelPath).toBe('不能为空')
    expect(errs.excelPath).not.toMatch(/[a-zA-Z]/)
  })

  it('数字上下界、数组长度、枚举都有中文说法', () => {
    expect(zodFieldErrors(z.number().min(3), 1)['']).toBe('不能小于 3')
    expect(zodFieldErrors(z.number().max(3), 5)['']).toBe('不能大于 3')
    expect(zodFieldErrors(z.string().max(3), 'abcd')['']).toBe('最多 3 个字符')
    expect(zodFieldErrors(z.array(z.string()).min(1), [])['']).toBe('至少要有一项')
    expect(zodFieldErrors(z.enum(['a', 'b']), 'c')['']).toBe('取值不在允许范围内')
  })

  it('必填项缺失与网址格式有专门说法', () => {
    expect(zodFieldErrors(z.object({ a: z.string() }), {})['a']).toBe('这一项还没填')
    expect(zodFieldErrors(z.string().url(), 'not-a-url')['']).toContain('网址')
  })

  it('自定义校验的中文 message 原样保留，不被兜底顶掉', () => {
    expect(zodFieldErrors(rpaConfigSchema, {
      excelPath: 'a.xlsx',
      colName: '客户',
      from: 5,
      to: 1,
      cmds: [],
    }).to).toBe('结束行不能小于起始行')
  })
})
