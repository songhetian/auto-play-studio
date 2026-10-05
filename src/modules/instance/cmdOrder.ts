/**
 * 指令序列的拖拽重排。
 *
 * 选中项存的是**下标**，所以重排后必须把下标跟着「它原来指的那条指令」走 ——
 * 否则右侧属性面板会指向另一条指令：用户以为在改 A，其实在改 B。
 *
 * 为什么不给 `Cmd` 加 id：那是持久化结构，老存档里没有。改下标映射零迁移成本。
 */

/** 重排后，原来的第 `sel` 条现在落在哪个下标（`sel < 0` 表示没选中） */
export function remapIndex(sel: number, from: number, to: number): number {
  if (sel < 0) return sel
  if (sel === from) return to
  // 向下拖：夹在 (from, to] 里的几条被顶到前面一位
  if (from < to && sel > from && sel <= to) return sel - 1
  // 向上拖：夹在 [to, from) 里的几条被挤到后面一位
  if (from > to && sel >= to && sel < from) return sel + 1
  return sel
}

/** 把第 `from` 条移到第 `to` 位（返回新数组，不改原数组） */
export function moveAt<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list]
  if (to < 0 || to >= list.length) return [...list]
  if (from === to) return [...list]
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
