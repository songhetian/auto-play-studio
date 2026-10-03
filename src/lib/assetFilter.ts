import type { AssetProblem, ImageAsset } from '@/lib/api'

/** 素材库筛选纯逻辑：跟 UI 无关，单独放出来好测也好复用 */

export const ALL_TAGS = '全部'

/** 按关键词（名称，忽略大小写）与标签过滤；`tag` 传「全部」等于不筛 */
export function filterAssets(
  assets: ImageAsset[],
  opts: { keyword?: string; tag?: string },
): ImageAsset[] {
  const kw = (opts.keyword ?? '').trim().toLowerCase()
  const tag = opts.tag ?? ALL_TAGS

  return assets.filter((a) => {
    if (tag !== ALL_TAGS && a.tag !== tag) return false
    if (kw && !a.name.toLowerCase().includes(kw)) return false
    return true
  })
}

/** 库里实际出现过的标签（去重、按中文顺序排好，避免每次渲染顺序都在跳） */
export function tagsOf(assets: ImageAsset[]): string[] {
  return [...new Set(assets.map((a) => a.tag))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh'))
}

/** 体检问题按素材归类，方便在卡片上打警告角标 */
export function groupProblems(problems: AssetProblem[]): Record<string, AssetProblem[]> {
  const out: Record<string, AssetProblem[]> = {}
  for (const p of problems) {
    ;(out[p.assetId] ??= []).push(p)
  }
  return out
}
