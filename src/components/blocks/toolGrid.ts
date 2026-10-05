import { RHYTHM } from '@/components/blocks/rhythm'

/**
 * 工具箱栅格规格（单一真源）。
 *
 * 之前每个分组各自写 `grid sm:grid-cols-2`，导致同一页里：
 *   - 只有 1 个工具的分组 → 卡片只占半行，右边一大片空白
 *   - 有 2 个工具的分组 → 刚好铺满整行
 * 两种宽度并排出现，视觉上完全不成体系（用户反馈「框的大小不一致、布局不协调」）。
 *
 * 现在整页共用同一套栅格：**卡片宽度只由栅格决定，与该分组有几个工具无关**。
 */

/** 栅格规格：数值来源与文档；真正的类名在 rhythm.ts（视觉节奏单一真源） */
export const TOOL_GRID = {
  /** 至少 2 列：单列会让卡片被拉得极宽，一屏放不下几个 */
  minColumns: 2,
  /** 宽屏 3 列：1440px 内容区（max-w-1240）下每列约 400px，正好放下「图标 + 名称 + 说明 + 按钮」 */
  wideColumns: 3,
  /** 卡片高度统一：说明文案最多两行，超出截断，避免同排卡片高矮不一 */
  minCardHeight: 132,
} as const

/**
 * 取某个分组用的栅格类名。
 *
 * 参数留着是为了将来某个分组真要特殊处理时有地方落；
 * 但**现在所有分组必须返回同一个值** —— 这正是 `toolGrid.test.ts` 在守的规则。
 *
 * ⚠️ rhythm.ts 里的类名必须是**字面量**：Tailwind JIT 扫源码找类名，
 * `` `xl:grid-cols-${n}` `` 拼出来的规则压根不会生成 —— 表现为「代码写了 3 列，页面还是 2 列」。
 */
export function toolGridClass(_sectionId?: string): string {
  return RHYTHM.grid
}

/**
 * 资源与系统入口的栅格。
 *
 * 单独一档，因为这些入口**不是工具、没有新建按钮**，卡片更矮；
 * 但数量通常是 5~6 个，用工具卡那套 `xl:grid-cols-3` 刚好两行放齐
 * （素材库 / 敏感词库 / 知识库 / Excel 工具箱 / Excel 体检 / 设置）。
 *
 * ⚠️ 列数必须与入口数成整数倍：不是整数倍时第二行会孤零零一张卡，
 * 那张卡既不同高、也像被落下去了。`toolGrid.test.ts` 在守这条。
 * 末位不足时用占位补齐（见 `padToColumns`）。
 */
export const UTILITY_GRID = 'grid items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3'

/**
 * `UTILITY_GRID` 在 lg 档的列数。
 *
 * 补位（`padToColumns`）必须用这个数，用错会把整数倍的入口补出多余空行。
 * 类名与这个常量必须在 lg 档上一致 —— `toolGrid.test.ts` 在守。
 */
export const UTILITY_COLUMNS = 3

/**
 * 把列表补齐到列数的整数倍。
 *
 * 4 个入口配 4 列刚好；将来加了第 5 个（话术库已是独立分组，但假设还有），
 * 5 个配 4 列会出现"第二行 1 张"，补 3 个不可见占位后，网格本身的高度仍然按一行算，
 * 那张卡不会再被拉高。
 */
export function padToColumns<T>(items: T[], columns: number): (T | null)[] {
  const rem = items.length % columns
  if (items.length === 0 || rem === 0) return items
  return [...items, ...Array.from({ length: columns - rem }, () => null)]
}
