/**
 * 客服流程方案的检索。
 *
 * 20 个方案以后，"横向排一条"必然找不到人，所以搜索必须能兜住三种回忆方式：
 *  1. 记得方案名（「退款处理」）
 *  2. 记得分类标签（「售后」）
 *  3. **只记得步骤里的一句话**（「怎么安抚客户」→ 投诉处理）
 * 第 3 条是这里最值钱的部分：新人接到任务时想不起流程名，只记得要做的事。
 *
 * 纯函数、不碰 store，方便单测。
 */

export interface FlowStep {
  id: string
  /** 步骤标题，如「接收退款申请」 */
  title: string
  /** 操作说明：具体点哪个按钮、填什么 */
  desc: string
  /** 截图 dataURL（可选）—— 有图才显示圈选区 */
  image?: string
  /** 圈选高亮区域，比例坐标 0~1（缩放不失真） */
  rect?: { x: number; y: number; w: number; h: number }
}

export interface Flow {
  id: string
  name: string
  /** 分类标签，如「售后」「物流」；用于筛选栏 */
  tags: string[]
  steps: FlowStep[]
  updatedAt?: string
}

export type FlowSort = 'recent' | 'name' | 'steps'

/** 汇总所有方案用到的标签，供筛选栏渲染。空串是「没填分类」，不算一个分类 */
export function flowCategories(flows: readonly Flow[]): string[] {
  const set = new Set<string>()
  for (const f of flows) for (const t of f.tags) if (t.trim()) set.add(t.trim())
  return [...set]
}

/**
 * 按查询词 + 分类筛选方案。多个词按 AND —— 空格分开都命中才保留。
 *
 * `category` 空串表示"全部分类"。命中范围是名称 / 标签 / 步骤标题 / 步骤说明。
 */
export function filterFlows(
  flows: readonly Flow[],
  query: string,
  category: string,
): Flow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)

  return flows.filter((f) => {
    // 与 flowCategories 口径一致：标签先 trim 再比，否则筛选栏显示的「售后」
    // 点下去会把带空白的标签那条筛没
    if (category && !f.tags.some((t) => t.trim() === category)) return false
    if (!terms.length) return true

    const haystack = [
      f.name,
      ...f.tags,
      ...f.steps.map((s) => s.title),
      ...f.steps.map((s) => s.desc),
    ]
      .join('\n')
      .toLowerCase()

    return terms.every((t) => haystack.includes(t))
  })
}

/**
 * 排序。返回新数组 —— 直接 in-place 排会改到 store 里的原数组。
 *
 * `recent` 把没有 updatedAt 的排最后：新建但还没动过的方案，
 * 压在最前面会让人以为"最近改的就是它"。
 */
export function sortFlows(flows: readonly Flow[], sort: FlowSort): Flow[] {
  const list = [...flows]
  switch (sort) {
    case 'name':
      return list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    case 'steps':
      return list.sort((a, b) => b.steps.length - a.steps.length)
    case 'recent':
    default:
      return list.sort((a, b) => {
        if (!a.updatedAt && !b.updatedAt) return 0
        if (!a.updatedAt) return 1
        if (!b.updatedAt) return -1
        return b.updatedAt.localeCompare(a.updatedAt)
      })
  }
}
