/**
 * 填入目标：客服客户端的窗口 + 输入框在屏幕上那块矩形。
 *
 * 字段名与引擎 `/api/assist/target` 一一对应（引擎那边叫 `Target`）。
 */

import type { AssistTarget } from '@/lib/api'

export type { AssistTarget }

/** 框选返回的矩形（与引擎 `selectRegion` 的返回一致） */
export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 框选结果 + 窗口关键字 → 可以存下去的目标；任何一项不合格都返回 `null`。
 *
 * 刻意**不抛异常**：取消框选是正常操作，不是错误。界面拿 `null` 就别存，
 * 顺便提示用户还差什么。
 *
 * 两道守卫的理由：
 * - **窗口关键字不能空**：引擎是按「标题包含」激活窗口的，空串会匹配到随便哪个
 *   窗口 —— 话术就打进别人的窗口了。
 * - **矩形必须有面积**：零面积没有中心可点，点下去落在边界那条线上。
 */
export function targetFromRegion(
  keyword: string,
  region: Region | null | undefined,
): AssistTarget | null {
  const window = (keyword ?? '').trim()
  if (!window) return null
  if (!region) return null
  const width = Math.round(region.width)
  const height = Math.round(region.height)
  if (!(width > 0) || !(height > 0)) return null
  return { window, x: Math.round(region.x), y: Math.round(region.y), width, height }
}

/** 配置卡上那一句话：填到哪儿。 */
export function targetLabel(target: AssistTarget | null): string {
  if (!target) return '还没框定输入框'
  return `${target.window} · ${target.x},${target.y} 起 ${target.width}×${target.height}`
}
