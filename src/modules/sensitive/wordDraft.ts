import type { SensitiveWordIn, WordLevel } from '@/lib/api'

/** 新增违禁词表单的草稿（界面用 camelCase 顺手） */
export interface WordDraft {
  word: string
  level: WordLevel
  matchKey: string
  note: string
}

/**
 * 草稿 → 接口载荷。
 *
 * 字段必须转成引擎认的 snake_case（`match_key`）。曾经把草稿整体发出去：
 * `matchKey` 不是引擎字段、被静默忽略 —— 用户手填的拼音键不生效，
 * 悄悄退回自动计算（用户以为配上了，实际没配）。
 */
export function draftToWordInput(draft: WordDraft): SensitiveWordIn {
  return {
    word: draft.word,
    level: draft.level,
    match_key: draft.matchKey,
    note: draft.note,
  }
}
