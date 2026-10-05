/**
 * 统一速查的合并逻辑（工单 04 · ①）。
 *
 * 把话术与知识库命中合并成一个列表，面板里 ↑↓ 跨节选中、Enter 分别动作
 * （话术插原输入框 / 知识库复制摘要）。纯函数：不碰网络、不碰状态，
 * 话术与 KB 命中各自的相关性排序在外面已经做好，这里只负责拼接成一条可导航的列表。
 *
 * 列表有两种入口，差别只在**哪一节在前**与**Enter 干什么**（见 `enterActionOf`）：
 *  - `Ctrl+Alt+P`（话术速查）：话术在前，往聊天框里插；
 *  - `Ctrl+Alt+K`（知识库速填）：知识库在前，填进事先框定的输入框。
 */
import type { Phrase } from '@/modules/phrases/usePhrases'
import type { KbHit } from '@/lib/api'

export type QuickKind = 'phrase' | 'kb'

export interface QuickItem {
  kind: QuickKind
  key: string
  title: string
  /** 列表里的预览文字：话术是正文、知识库是片段摘要 */
  preview: string
  phrase?: Phrase
  kb?: KbHit
}

/** KB 命中摘要：前几条片段拼成一行，过长截断（列表里只给一眼能看完的量） */
export function kbPreview(hit: KbHit, max = 80): string {
  const text = hit.snippets
    .map((s) => s.text)
    .join(' … ')
    .trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

/**
 * 把两节拼成一条可 ↑↓ 导航的列表；两边都按各自相关性排好序，这里只负责拼接。
 *
 * `kbFirst` 决定谁在前：默认话术在前（作业侧最高频）；知识库速填那条入口
 * 明确是冲知识库去的，让客服先滚过一屏话术没有道理。
 * 返回的每个 item 带 `kind` 与稳定 `key`，面板据此决定 Enter 时做什么。
 */
export function mergeQuick(phrases: Phrase[], kb: KbHit[], kbFirst = false): QuickItem[] {
  const phraseItems: QuickItem[] = phrases.map((p) => ({
    kind: 'phrase',
    key: `phrase:${p.id}`,
    title: p.title,
    preview: p.body,
    phrase: p,
  }))
  const kbItems: QuickItem[] = kb.map((h) => ({
    kind: 'kb',
    key: `kb:${h.path}`,
    title: h.fileName,
    preview: kbPreview(h),
    kb: h,
  }))
  return kbFirst ? [...kbItems, ...phraseItems] : [...phraseItems, ...kbItems]
}

/**
 * 知识库命中要"送出去"的那段文字。
 *
 * 有一条比"有内容"更硬的约束：**绝不能是空串**。填入动作会先抢屏幕焦点再打字，
 * 空着送进去等于白抢一次焦点 —— 客服正在打的字被顶掉，输入框里还是空的。
 * 所以片段拼出来是空（没有片段、或者片段全是空白）时退回文件名，至少让客服
 * 看见"命中的是哪个文件"，而不是毫无反馈。
 */
export function kbFillText(hit: KbHit): string {
  const text = hit.snippets
    .map((s) => s.text)
    .join('\n')
    .trim()
  return text || hit.fileName
}

/** 面板的两种入口。`phrase` = 话术速查（Ctrl+Alt+P），`kb` = 知识库速填（Ctrl+Alt+K） */
export type PanelMode = 'phrase' | 'kb'

/** 按下 Enter 时对当前选中项做什么 */
export type EnterAction = 'insert' | 'copy' | 'fill'

/**
 * Enter 行为的唯一判据 —— 放在这里而不是塞进组件的 if 里，是因为它是一张
 * 「模式 × 条目类型 → 动作」的真值表，值得被独立钉住：
 *
 * | | 话术 | 知识库 |
 * |---|---|---|
 * | `phrase` 模式 | `insert` 插回原窗口 | `copy` 只复制（长文不往客户框里塞） |
 * | `kb` 模式 | `fill` 填入 | `fill` 填入 |
 *
 * kb 模式里话术同样走 `fill`：既然已经框定了输入框，两节就该走同一条出口，
 * 混着两种送法只会让"东西去哪了"变得不可预测。
 */
export function enterActionOf(mode: PanelMode, kind: QuickKind): EnterAction {
  if (mode === 'kb') return 'fill'
  return kind === 'kb' ? 'copy' : 'insert'
}
