import { describe, expect, it } from 'vitest'
import { inferVars } from './fillVars'

/**
 * 变量自动填（工单 04 · ③）。
 *
 * 从选区 / 剪贴板推断话术 {变量} 的值：客服每天要手填几十次「客户名」，
 * 能推断就直接替掉，推断不出就保留占位符（绝不瞎猜后发出错话）。
 * 期望值手写；覆盖「能推断 / 推断不出 / 多个变量」三种。
 */
describe('inferVars', () => {
  it('从选区推断客户名与订单号', () => {
    const r = inferVars(
      '您好 {客户名}，您的订单 {订单号} 已发出',
      '亲，张三的订单号 NO2026ABC，请查收',
    )
    expect(r).toEqual({ 客户名: '张三', 订单号: 'NO2026ABC' })
  })

  it('变量名带「客户」也认（{客户} 等同 {客户名}）', () => {
    const r = inferVars('{客户} 您好', '李先生 你好')
    expect(r).toEqual({ 客户: '李先生' })
  })

  it('推断不出就不返回该变量（调用方保留占位符 + 提醒）', () => {
    const r = inferVars('您好 {客户名}，看一下 {订单号}', '亲，这个件已经发了')
    expect(r).toEqual({})
  })

  it('没有变量可填返回空', () => {
    expect(inferVars('普通话术，无变量', '张三 的订单 NO1')).toEqual({})
  })

  it('只填能从来源推断出来的，其余保留', () => {
    const r = inferVars('{客户名} 的 {订单号} 已发', '王五 你好')
    expect(r).toEqual({ 客户名: '王五' })
  })
})
