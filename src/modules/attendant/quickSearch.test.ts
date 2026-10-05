import { describe, expect, it } from 'vitest'
import { enterActionOf, kbFillText, kbPreview, mergeQuick, type QuickItem } from './quickSearch'
import type { Phrase } from '@/modules/phrases/usePhrases'
import type { KbHit } from '@/lib/api'

const PHRASE = (id: number, title: string, body: string): Phrase =>
  ({ id, title, body, category: '', usedCount: 0, createdAt: '', updatedAt: '' }) as Phrase

const KB = (path: string, fileName: string, snippets: string[]): KbHit =>
  ({
    path,
    fileName,
    fileType: 'md',
    size: 0,
    mtime: 0,
    truncated: false,
    score: 1,
    matchMode: 'and',
    matchCount: snippets.length,
    snippets: snippets.map((text, line) => ({ line, text })),
    matchedBy: 'keyword',
  }) as KbHit

describe('kbPreview', () => {
  it('把片段拼成一行预览', () => {
    expect(kbPreview(KB('a', 'f', ['第一段内容', '第二段内容']))).toBe('第一段内容 … 第二段内容')
  })
  it('过长截断', () => {
    const long = 'x'.repeat(200)
    const p = kbPreview(KB('a', 'f', [long]), 80)
    expect(p.length).toBe(81) // 80 + '…'
    expect(p.endsWith('…')).toBe(true)
  })
})

describe('mergeQuick', () => {
  it('话术在前、知识库在后，且都带 section 标记', () => {
    const items = mergeQuick(
      [PHRASE(1, '退款流程', '亲，退款 3-5 天到账')],
      [KB('doc/x.md', '退费政策.md', ['超过 7 天可退'])],
    )
    expect(items.map((i) => i.kind)).toEqual(['phrase', 'kb'])
    expect(items[0].key).toBe('phrase:1')
    expect(items[1].key).toBe('kb:doc/x.md')
  })

  it('话术数 + 知识库数 = 总数，跨节选中靠一个 index 即可', () => {
    const items: QuickItem[] = mergeQuick(
      [PHRASE(1, 'a', 'x'), PHRASE(2, 'b', 'y')],
      [KB('d/1.md', 'f1', ['s']), KB('d/2.md', 'f2', ['s'])],
    )
    expect(items).toHaveLength(4)
    expect(items[2].kind).toBe('kb')
    expect(items[2].title).toBe('f1')
  })

  it('两边都为空返回空列表', () => {
    expect(mergeQuick([], [])).toEqual([])
  })

  it('只有知识库时列表全为 kb', () => {
    const items = mergeQuick([], [KB('d/1.md', 'f1', ['s'])])
    expect(items).toHaveLength(1)
    expect(items[0].preview).toContain('s')
  })
})

describe('mergeQuick · 知识库优先（Ctrl+Alt+K 唤起时）', () => {
  it('kbFirst 时知识库在前、话术在后', () => {
    const items = mergeQuick([PHRASE(1, 'a', 'x')], [KB('d/1.md', 'f', ['s'])], true)
    expect(items.map((i) => i.kind)).toEqual(['kb', 'phrase'])
  })

  it('两节内部各自的顺序不被打乱', () => {
    const items = mergeQuick(
      [PHRASE(1, 'a', 'x'), PHRASE(2, 'b', 'y')],
      [KB('d/1.md', 'f1', ['s']), KB('d/2.md', 'f2', ['s'])],
      true,
    )
    expect(items.map((i) => i.key)).toEqual(['kb:d/1.md', 'kb:d/2.md', 'phrase:1', 'phrase:2'])
  })

  it('不传 kbFirst 时仍是话术在前 —— 老调用点行为一字不改', () => {
    const items = mergeQuick([PHRASE(1, 'a', 'x')], [KB('d/1.md', 'f', ['s'])])
    expect(items.map((i) => i.kind)).toEqual(['phrase', 'kb'])
  })
})

describe('kbFillText', () => {
  it('多段片段按换行拼接，供填入输入框', () => {
    expect(kbFillText(KB('a', 'f', ['第一段', '第二段']))).toBe('第一段\n第二段')
  })

  it('一段片段都没有时退回文件名', () => {
    expect(kbFillText(KB('a', '退费政策.md', []))).toBe('退费政策.md')
  })

  it('片段全是空白时同样退回文件名', () => {
    // 只按 join 结果判空会漏掉这种：'   \n  ' 是真值，填进去等于往输入框塞空行
    expect(kbFillText(KB('a', '退费政策.md', ['   ', '  ']))).toBe('退费政策.md')
  })

  it('去掉首尾空白：填进输入框不该有前导空行', () => {
    expect(kbFillText(KB('a', 'f', ['  正文  ']))).toBe('正文')
  })
})

describe('enterActionOf', () => {
  it('phrase 模式：话术插回原窗口、知识库只复制', () => {
    expect(enterActionOf('phrase', 'phrase')).toBe('insert')
    expect(enterActionOf('phrase', 'kb')).toBe('copy')
  })

  it('kb 模式：一律填入框定的输入框（只填不发送）', () => {
    expect(enterActionOf('kb', 'phrase')).toBe('fill')
    expect(enterActionOf('kb', 'kb')).toBe('fill')
  })
})
