import type { InputSize } from './input'

/**
 * 输入框的留白与字号：**单一真源**。
 *
 * 为什么抽出来（而不是直接把 `px-2.5` 写在 input.tsx 里）：
 * 裸 `<input>` 在 Tailwind 预检下没有任何内边距，文字会直接贴左边框；
 * 而带 prefix 的分支包了一层容器、有自己的 `px-2.5`。
 * 结果是同一个应用里"有的输入框很挤、有的正常"，用户说"输入框局促"。
 *
 * 抽成函数后可以被测试钉住：改坏了（又变回无内边距）测试会红。
 */

/** 横向内边距：小号最紧、大号最松，但三档都不为 0。
 *  默认档定为 px-3 —— 用户反馈"输入框过于靠左、空间局促"，且与 Textarea 对齐。 */
const PADDING: Record<InputSize, string> = {
  sm: 'px-2.5',
  default: 'px-3',
  lg: 'px-3.5',
}

/** 高度 + 字号 */
const TYPO: Record<InputSize, string> = {
  sm: 'h-7 text-sm',
  default: 'h-8 text-base',
  lg: 'h-9 text-base',
}

/**
 * ⚠️ 类名必须写字面量：Tailwind JIT 扫源码文本找候选类名，
 * 模板字符串拼出来的 `px-${n}` 在源码里搜不到，规则压根不生成 ——
 * 表现为「代码写了内边距，页面上还是贴边」，且不报任何错。
 */
export function inputPadding(size: InputSize = 'default'): string {
  return PADDING[size]
}

export function inputTypo(size: InputSize = 'default'): string {
  return TYPO[size]
}

/** 裸 input 与带前缀容器共用的基础样式 */
export const FIELD_BASE =
  'flex w-full items-center rounded-md border bg-background shadow-sm transition-all duration-150 ' +
  'placeholder:text-muted-foreground ' +
  'border-input hover:border-foreground/30 ' +
  // Arco 特征：聚焦时边框变品牌色 + 外圈柔光
  'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-55'

export const ERROR_CLS =
  'border-destructive hover:border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20'