/**
 * 视觉节奏规范（单一真源）。
 *
 * 「不像专业软件」这个感受，拆开看主要是**节奏不统一**：
 *  - 8 个页面根容器里 7 个 `space-y-4`、1 个 `space-y-5` → 换页时纵向节奏会跳一下
 *  - 内部层级混用了 space-y-1/1.5/2/2.5/3/4/5 共 7 种（4/6/8/10/12/16/20px），
 *    其中 6px 与 8px、10px 与 12px 在屏幕上几乎分辨不出，却让代码里多出两套"看起来一样"的规则
 *
 * 这里把节奏收敛成**三档**，并给出每个数字的依据：
 *  - 页面区块之间 20px（space-y-5）：一屏能放下 4~5 个区块，再紧就分不清谁是谁
 *  - 区块内部小节之间 12px（space-y-3）：比区块之间紧一档，眼睛能顺着标题往下读
 *  - 列表项/设置行之间 8px（space-y-2）：再紧就粘成一片
 *
 * ⚠️ 所有类名必须是**字面量**：Tailwind JIT 扫源码找类名，拼接出来的规则不会生成，
 * 表现为「代码写了但页面没变」。
 */

export const RHYTHM = {
  /** 页面外框：统一 1240px 宽、统一 20px 内边距、统一 20px 区块间距 */
  pageShell: 'mx-auto max-w-[1240px] space-y-5 p-5',
  /** 页面中大区块之间 */
  pageStack: 'space-y-5',
  /** 同一区块内、小节之间 */
  sectionStack: 'space-y-3',
  /** 标题行：标题 + 右侧说明/操作 */
  titleRow: 'flex items-end gap-3',
  /** 工具入口栅格：与 toolGrid 同一套列宽 */
  grid: 'grid items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-3',
  stack: {
    /** 松：页面/大区块之间 */
    loose: 'space-y-5',
    /** 紧：区块内部 */
    tight: 'space-y-3',
  },
  inner: {
    /** 列表项、设置行之间（8px：再紧就粘成一片） */
    item: 'space-y-2',
  },
} as const

/* ── 辅助函数：让调用方只能拿到规范里的值，不能自己拼 ── */

export const pageShell = (): string => RHYTHM.pageShell
export const pageStack = (): string => RHYTHM.pageStack
export const sectionStack = (): string => RHYTHM.sectionStack
export const titleRow = (): string => RHYTHM.titleRow
