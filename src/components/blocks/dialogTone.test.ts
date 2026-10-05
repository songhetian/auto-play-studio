import { describe, expect, it } from 'vitest'
import { DIALOG_TONE, dialogToneOf, toneByAction, dialogShellClass } from './dialogTone'

/**
 * 弹窗语义分型的规格。
 *
 * 现状问题：11 个弹窗调用点，但视觉上**全都一样** —— 灰底卡片 + 24px 小图标。
 * 用户点「删除实例」和点「重新索引」看到的是同一种框子，扫一眼分不出
 * 「这件事会不会弄丢数据」。危险动作本该在视觉上就比信息提示更重。
 *
 * 规格：
 *  - 弹窗按**语义**分四类：危险 / 警告 / 信息 / 表单
 *  - 危险类有明显的红色强调（顶条 + 图标底色 + 主按钮），不是只把按钮变红
 *  - 每类有各自推荐的默认图标，调用方不传就用推荐值
 *  - 提示语气不同：危险类默认禁掉回车确认，防手滑直接删掉
 */
describe('弹窗语义分型', () => {
  it('四个语义类型齐全', () => {
    expect(Object.keys(DIALOG_TONE).sort()).toEqual(['danger', 'form', 'info', 'warn'])
  })

  it('每类都有推荐图标_调用方不传也能看出是什么事', () => {
    for (const k of Object.keys(DIALOG_TONE) as Array<keyof typeof DIALOG_TONE>) {
      expect(DIALOG_TONE[k].icon, k).toBeTruthy()
    }
  })

  it('只有危险/警告类有文字徽标_中性类不显示标签免得视觉噪音', () => {
    // 中性弹窗加个"提示"徽标只会让弹窗显得吵
    expect(DIALOG_TONE.danger.label).toBeTruthy()
    expect(DIALOG_TONE.warn.label).toBeTruthy()
    expect(DIALOG_TONE.info.label).toBe('')
    expect(DIALOG_TONE.form.label).toBe('')
  })

  it('危险类有红色强调带_扫一眼就该知道会丢数据', () => {
    // 不只是按钮变红：整个弹窗要有一道强调，否则第一眼分辨不出来
    expect(DIALOG_TONE.danger.accent).toBe('danger')
    expect(DIALOG_TONE.danger.guardEnter).toBe(true)
  })

  it('信息类不阻止回车_它是"知道了"不是"确定吗"', () => {
    expect(DIALOG_TONE.info.guardEnter).toBe(false)
  })

  it('只有危险类阻止回车确认_警告类不该拦_用户可能正要确认', () => {
    expect(DIALOG_TONE.warn.guardEnter).toBe(false)
    expect(DIALOG_TONE.form.guardEnter).toBe(false)
  })

  it('按动作推出语义类型_调用方不必自己判断', () => {
    // 删除类动作 → danger
    expect(dialogToneOf({ action: 'delete' })).toBe('danger')
    expect(dialogToneOf({ action: 'remove' })).toBe('danger')
    expect(dialogToneOf({ action: 'unregister' })).toBe('danger')
    // 覆盖/清理类 → warn（有风险但不是删）
    expect(dialogToneOf({ action: 'overwrite' })).toBe('warn')
    expect(dialogToneOf({ action: 'clear' })).toBe('warn')
    // 常规操作 → info
    expect(dialogToneOf({ action: 'apply' })).toBe('info')
    expect(dialogToneOf({ action: 'stop' })).toBe('info')
  })

  it('显式传入的 tone 优先于按动作推断', () => {
    expect(dialogToneOf({ action: 'delete', tone: 'warn' })).toBe('warn')
  })

  it('认不出的动作不猜_默认 info 而不是误判成 danger', () => {
    // 宁可少一点红色，也不要让"保存"弹窗忽然变成红的
    expect(dialogToneOf({ action: 'weird-unknown' })).toBe('info')
    expect(dialogToneOf({})).toBe('info')
  })

  it('toneByAction 直接给出一整套呈现规则', () => {
    const d = toneByAction('delete')
    expect(d.id).toBe('danger')
    expect(d.icon).toBe('trash')
    expect(d.accent).toBe('danger')
    expect(d.guardEnter).toBe(true)
  })

  it('弹窗外框类名是字面量_Tailwind 扫不到就等于没样式', () => {
    const cls = dialogShellClass('danger')
    // 每类都要有各自的强调带，靠 Tailwind 字面量拼出来
    expect(cls).toContain('border-t')
    expect(cls).not.toContain('${')
    expect(cls).not.toContain('`')
  })

  it('危险与警告的强调色必须不同_否则分级失去意义', () => {
    expect(DIALOG_TONE.danger.accent).not.toBe(DIALOG_TONE.warn.accent)
  })
})
