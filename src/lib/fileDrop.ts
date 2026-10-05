/**
 * 拖拽 / 选择上传的文件筛选。
 *
 * 原来散在 `Dropzone` 里的三个问题，抽出来变成可测的纯函数：
 *  1. 只取 `files[0]` —— 拖 5 个进来只处理 1 个，另外 4 个**静默消失**
 *  2. 扩展名不符直接 `return` —— 用户**看不到任何提示**，只觉得"拖了没反应"
 *  3. 没有多选
 *
 * 关键取舍：**被拒的文件必须逐个说清原因**。静默丢弃是最糟的处理 ——
 * 用户以为文件传上去了，真正处理时才发现少了一半。
 */

export interface RejectedFile {
  name: string
  reason: string
}

export interface FileFilterResult {
  accepted: File[]
  rejected: RejectedFile[]
}

/** 支持的音频扩展名（提醒/告警自定义音频共用） */
export const AUDIO_EXT = '.wav,.mp3,.m4a'

/** Excel 与常见表格格式 */
export const SHEET_EXT = '.xlsx,.xls,.csv'

/** 文档类（知识库索引） */
export const DOC_EXT = '.pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.md,.txt'

/** 图片类（素材库） */
export const IMAGE_EXT = '.png,.jpg,.jpeg,.gif,.bmp,.webp'

/** 视频类（抽帧 / 意图定位） */
export const VIDEO_EXT = '.mp4,.mov,.avi,.mkv,.webm,.flv,.wmv'

/** 文件大小可读化 */
export function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 取扩展名（小写、不含点）。只认**最后一段**，`a.xlsx.bak` 不能被当成 Excel */
const extOf = (name: string): string => {
  const base = (name || '').split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  // 没有点、或点在开头（`.gitignore` 这类隐藏文件）都算「无扩展名」
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

const parseAccept = (accept: string): string[] =>
  (accept || '')
    .split(',')
    .map((s) => s.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean)

/**
 * 按 accept 与大小限制筛选文件。
 *
 * @param maxSize 单文件上限（字节）。给了就会拦，并在原因里说清。
 */
export function filterFiles(files: File[] | FileList | null | undefined, accept: string, maxSize?: number): FileFilterResult {
  const list = files ? Array.from(files) : []
  if (!list.length) return { accepted: [], rejected: [] }

  const allowed = parseAccept(accept)
  const accepted: File[] = []
  const rejected: RejectedFile[] = []

  for (const f of list) {
    const ext = extOf(f.name)
    if (!ext) {
      rejected.push({ name: f.name, reason: '没有扩展名，说不清是什么格式' })
      continue
    }
    if (allowed.length && !allowed.includes(ext)) {
      rejected.push({ name: f.name, reason: `格式不支持（只收 ${allowed.map((a) => '.' + a).join(' / ')}）` })
      continue
    }
    if (maxSize && f.size > maxSize) {
      rejected.push({ name: f.name, reason: `大小 ${formatSize(f.size)}，超过上限 ${formatSize(maxSize)}` })
      continue
    }
    accepted.push(f)
  }

  return { accepted, rejected }
}

/**
 * 把筛选结果说成一句人话。
 * 有退回文件时必须点名，否则用户不知道少了几份。
 */
export function describeFiles(r: FileFilterResult): string {
  if (!r.rejected.length) {
    return r.accepted.length ? `已选择 ${r.accepted.length} 个文件` : ''
  }
  const names = r.rejected.map((x) => x.name).join('、')
  return `已收下 ${r.accepted.length} 个；退回 ${r.rejected.length} 个：${names}`
}
