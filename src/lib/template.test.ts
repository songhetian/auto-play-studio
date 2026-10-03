import { describe, expect, it } from 'vitest'

import raw from '@/lib/template.cases.json'
import { TemplateError, renderTemplate, templateIssues, templateParts, type TemplateRow } from '@/lib/template'

/**
 * Seam：模板渲染（`src/lib/template.ts`）。
 *
 * 这里跑的用例和 `python/tests/test_template.py` 跑的是**同一组**。
 * 拿同一份数据打两侧，是「前后端不漂移」这条约束唯一能真正生效的方式 ——
 * 各自维护一套测试只会各自绿着漂。
 */

type RenderCase = { id: string; why: string; tpl: string; row: TemplateRow; out: string }
type FormatCase = { fmt: string; arg?: string; in: unknown; out: string; why?: string }
type ErrorCase = { id: string; why: string; tpl: string; row: TemplateRow; message_contains: string }
type IssueCase = { why: string; tpl: string; columns: string[]; issues: string[] }

const CASES = raw as unknown as {
  render: RenderCase[]
  format: FormatCase[]
  issues: IssueCase[]
  errors: ErrorCase[]
}

describe('模板渲染', () => {
  it.each(CASES.render)('$id', (c) => {
    expect(renderTemplate(c.tpl, c.row)).toBe(c.out)
  })
})

describe('格式化器边界打表', () => {
  it.each(CASES.format)('$fmt:$arg:$in', (c) => {
    const spec = c.arg ? `${c.fmt}:${c.arg}` : c.fmt
    expect(renderTemplate(`{值|${spec}}`, { values: { 值: c.in } })).toBe(c.out)
  })
})

describe('必须整行失败的情形', () => {
  it.each(CASES.errors)('$id', (c) => {
    expect(() => renderTemplate(c.tpl, c.row)).toThrow(TemplateError)
    expect(() => renderTemplate(c.tpl, c.row)).toThrowError(c.message_contains)
  })
})

describe('保存时校验', () => {
  it.each(CASES.issues)('$tpl', (c) => {
    // 全等而不是包含：文案本身也是前后端之间的契约
    expect(templateIssues(c.tpl, c.columns)).toEqual(c.issues)
  })
})

/**
 * Seam：`templateParts` —— 预览把模板切成「普通文字 / 占位符」，写错的标红。
 *
 * 期望值是手写的字面量，不从实现里抄。这里单独测的理由很具体：
 * 这段逻辑原来是内联在 `TemplatePreview` 里的，**判错了一次也没人发现** ——
 * 组件的文字断言（报错列表）照常有内容，只有样式是错的，
 * 而样式不在任何自动化断言里。
 */
describe('预览标红切分', () => {
  const COLS = ['订单编号', '退款金额']

  it('写对的占位符不标红、写错的标红，中间的文字原样留着', () => {
    expect(templateParts('订单号：{订单编号} 金额：{金额|money}', COLS)).toEqual([
      { text: '订单号：', bad: false },
      { text: '{订单编号}', bad: false },
      { text: ' 金额：', bad: false },
      { text: '{金额|money}', bad: true },
    ])
  })

  it('未知的格式化器也算写错', () => {
    expect(templateParts('{退款金额|currency}', COLS)).toEqual([{ text: '{退款金额|currency}', bad: true }])
  })

  it('一个列都没有时谁都不标红 —— 用户还没上传 Excel，标红只会是假警', () => {
    expect(templateParts('{客户名字}', [])).toEqual([{ text: '{客户名字}', bad: false }])
  })

  it('没有占位符时整段原样返回，空模板返回空', () => {
    expect(templateParts('普通文字', COLS)).toEqual([{ text: '普通文字', bad: false }])
    expect(templateParts('', COLS)).toEqual([])
  })
})
