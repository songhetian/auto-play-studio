/**
 * 同义词表的 JSON 导入/导出 —— 让用户把词库导出成文件、发给同事、再导入回来，
 * 实现跨机器分享（数据在 localStorage，没有后端兜底，文件是唯一可迁移载体）。
 *
 * 拆分两层：
 * - `serializeGroups` / `parseGroups`：纯函数、可单测，负责 envelope 与校验归一化；
 * - `downloadGroups` / `readGroupsFile`：DOM 副作用（下载/选文件），不被单测覆盖，但受 tsc 兜底。
 *
 * envelope 形状：`{ schemaVersion: 1, groups: string[][] }`，同时也兼容裸的 `string[][]`。
 */

/** 把同义词组序列化成带版本号的 JSON 文本（带缩进，人也能直接读/改） */
export function serializeGroups(groups: string[][]): string {
  return JSON.stringify({ schemaVersion: 1, groups }, null, 2)
}

/**
 * 解析同义词表 JSON 文本。
 * - 接受 `{ groups: string[][] }` 信封，或裸的 `string[][]`；
 * - 校验形状，非法时抛带中文的清晰错误；
 * - 归一化：去首尾空格、丢空词、组内去重、丢空组。
 */
export function parseGroups(text: string): string[][] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文本')
  }

  const rawGroups =
    Array.isArray(data)
      ? data
      : data && typeof data === 'object' && 'groups' in (data as Record<string, unknown>)
        ? (data as { groups: unknown }).groups
        : undefined

  if (!Array.isArray(rawGroups)) {
    throw new Error('JSON 顶层应为同义词组数组，或包含 groups 字段的对象')
  }

  const out: string[][] = []
  for (const g of rawGroups) {
    if (!Array.isArray(g)) throw new Error('同义词组必须是字符串数组')
    const seen = new Set<string>()
    const words: string[] = []
    for (const w of g) {
      if (typeof w !== 'string') throw new Error('同义词组里的每个元素都必须是字符串')
      const t = w.trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      words.push(t)
    }
    if (words.length) out.push(words)
  }
  return out
}

/** 默认文件名用**本地日期**：toISOString() 是 UTC，凌晨导出会差一天 */
export function defaultSynonymFilename(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `synonyms-${y}-${m}-${d}.json`
}

/** 浏览器里触发一次 JSON 文件下载（不进单测，仅 tsc 兜底） */
export function downloadGroups(groups: string[][], filename = defaultSynonymFilename()): void {
  const blob = new Blob([serializeGroups(groups)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * 弹出文件选择器，读入并解析成同义词组。
 * 用户取消选择时返回 null（不算错误）；解析失败则向上抛。
 */
export function readGroupsFile(): Promise<string[][] | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      file
        .text()
        .then((t) => resolve(parseGroups(t)))
        .catch((e) => reject(e instanceof Error ? e : new Error(String(e))))
    }
    input.click()
  })
}
