/**
 * 输出路径的派生规则（纯函数，便于单测）。
 *
 * 背景：Excel 类工具（物流查询、多表对比、Excel 体检）的输出文件都是**派生**的 ——
 * 与原文件同目录、名字加后缀。用户看到的是一个只读路径；
 * 而"输出目录"如果单独再配一份，就会出现"文件其实写到别处了"的困惑。
 * 所以规则是：**输出目录默认跟随原文件所在目录**，需要改时再显式覆盖。
 */

/** 从路径里取出目录部分（没有目录就返回空串，而不是 "." 这种相对路径） */
export function dirOf(p: string): string {
  const s = (p || '').trim()
  if (!s) return ''
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  if (i < 0) return ''
  return s.slice(0, i)
}

/**
 * 派生输出文件路径。
 *
 * - 目录跟随原文件；后缀插在扩展名之前（`订单.xlsx` → `订单_物流信息.xlsx`）
 * - 不认识的后缀原样保留：把 `.xls` 改成 `.xlsx` 会让文件打不开
 * - 原文件为空时返回空串：界面据此显示「上传后自动生成」，而不是显示一段假路径
 */
export function outputPathOf(src: string, suffix: string, ext?: string): string {
  const s = (src || '').trim()
  if (!s) return ''
  const m = /\.([A-Za-z0-9]+)$/.exec(s)
  if (!m) return s + suffix
  const stem = s.slice(0, -m[1].length - 1)
  const e = ext ? ext.replace(/^\./, '') : m[1]
  return `${stem}${suffix}.${e}`
}

/** 默认输出目录：与原文件同目录；原文件没目录时返回空串（用引擎的工作目录） */
export function suggestOutputDir(src: string): string {
  return dirOf(src)
}

/** 按扩展名过滤文件列表（从"这个目录里选"进"只能选 xlsx"） */
export function filterByExt(exts: string[], dir: string): string {
  const want = exts.map((e) => e.toLowerCase().replace(/^\./, ''))
  return want.join(';')
}

/** 取文件名（含扩展名） */
export function baseName(p: string): string {
  const s = (p || '').trim()
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i < 0 ? s : s.slice(i + 1)
}

/** 拼路径：目录为空时直接返回文件名（避免出现 `/订单.xlsx` 这种坏路径） */
export function joinPath(dir: string, name: string): string {
  const d = (dir || '').trim().replace(/[\\/]+$/, '')
  if (!d) return name
  return d.includes('\\') ? `${d}\\${name}` : `${d}/${name}`
}
