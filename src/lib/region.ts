/**
 * 监控区域的表达与解析。
 *
 * 配置里存的是一个字符串（与引擎 `_parse_region` 的约定一致）：
 *  - `full`          → 整屏
 *  - `x,y,w,h`       → 屏幕物理像素矩形
 *  - 空 / 其它非法值 → 按整屏处理
 *
 * UI 上不该让用户手写这个字符串，所以这里提供结构化的解析/回写，
 * 让页面用「整屏 / 自定义 + 四个数字框」来表达同一件事。
 */

export type MonitorRegion =
  | { kind: 'full' }
  | { kind: 'rect'; x: number; y: number; width: number; height: number }

/** 引擎侧约定：整屏的字符串写法 */
export const REGION_FULL = 'full'

export function parseRegion(raw: string | null | undefined): MonitorRegion {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s || s === REGION_FULL) return { kind: 'full' }

  const parts = s.split(',').map((p) => p.trim())
  if (parts.length !== 4) return { kind: 'full' }

  const nums = parts.map(Number)
  // 四个都得是有限数字，且宽高为正；否则视为非法 → 整屏
  if (nums.some((n) => !Number.isFinite(n))) return { kind: 'full' }
  const [x, y, width, height] = nums
  if (width <= 0 || height <= 0) return { kind: 'full' }

  return { kind: 'rect', x, y, width, height }
}

/** 回写成配置字符串 */
export function formatRegion(region: MonitorRegion): string {
  if (region.kind === 'full') return REGION_FULL
  const { x, y, width, height } = region
  return [x, y, width, height].map((n) => Math.round(n)).join(',')
}

/** 区域是否覆盖了有效范围（用于「保存」前的提示） */
export function regionCoverage(region: MonitorRegion): string {
  return region.kind === 'full' ? '整屏' : `${region.width} × ${region.height}`
}
