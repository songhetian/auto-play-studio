/** 拖拽条目：只声明这里真正用到的那几个成员，测试里可以手搓假实现 */
export interface EntryLike {
  isFile?: boolean
  isDirectory?: boolean
  name?: string
  fullPath?: string
}

/** `DataTransferItem` 里我们只用到这两个成员（真实类型带一堆用不上的） */
export interface DataTransferItemLike {
  kind?: string
  webkitGetAsEntry?: () => EntryLike | null
}

/**
 * 从拖拽事件里取出条目 —— **只用于判断「拖进来的是不是文件夹」**。
 *
 * ⚠️ 别拿这里的 `fullPath` 当路径用：那是虚拟路径（`/售后资料`），没有盘符，
 * 登记进知识库必然失败。真路径请走 {@link rootFoldersFrom} 或系统目录选择器。
 *
 * 只取 `kind === 'file'` 且真能取到 entry 的；浏览器没有 `webkitGetAsEntry`
 * （Firefox）时返回空列表，由界面回退到选择器而不是静默失败。
 */
export function entriesFromDataTransfer(
  items: DataTransferItemLike[] | null | undefined,
): EntryLike[] {
  const out: EntryLike[] = []
  for (const it of items ?? []) {
    if (it?.kind !== 'file') continue
    const entry = it.webkitGetAsEntry?.()
    if (entry) out.push(entry)
  }
  return out
}

/** 拖进来的东西里有普通文件吗 —— 用来提示「知识库登记的是文件夹」 */
export function hasFileEntry(entries: EntryLike[]): boolean {
  return (entries ?? []).some((e) => !!e?.isFile)
}

/** 选文件夹拿到的单个文件：绝对路径由 Electron 给出，相对路径浏览器自带 */
export interface PickedFile {
  /** 例 `D:\资料\售后\2026\a.xlsx`；浏览器预览态拿不到时为空串 */
  absolutePath: string
  /** 例 `售后/2026/a.xlsx` —— **第一段就是所选文件夹名** */
  relativePath: string
}

/**
 * 从「选了文件夹」的 FileList 反推出根文件夹的**绝对路径**。
 *
 * 这是目前唯一能在渲染进程里拿到真实磁盘位置的路子：
 * `<input type="file" webkitdirectory>` 的每个 File 都带真实绝对路径
 * （经 preload 的 `webUtils.getPathForFile` / 旧版 `file.path`）**和**
 * `webkitRelativePath`；把「相对路径去掉第一段」从绝对路径里减掉，
 * 剩下的就是所选文件夹本身。
 *
 * 宁可少给也不给半截路径：缺任一段、或两者对不上，一律跳过。
 */
export function rootFoldersFrom(files: PickedFile[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const f of files ?? []) {
    const abs = (f?.absolutePath ?? '').trim()
    if (!abs) continue
    // webkitRelativePath 用正斜杠；统一成反斜杠才好和 Windows 路径对齐
    const segments = (f?.relativePath ?? '').trim().replace(/\//g, '\\').split('\\').filter(Boolean)
    // 只有一段 = 普通「选文件」，没有目录信息
    if (segments.length < 2) continue
    // 去掉第一段（所选文件夹本身），剩下的才是文件相对于该文件夹的部分
    const tail = segments.slice(1).join('\\')
    if (!abs.toLowerCase().endsWith(tail.toLowerCase())) continue
    const root = abs.slice(0, abs.length - tail.length).replace(/[\\]+$/, '')
    if (!root) continue
    const key = root.toLowerCase() // Windows 上目录名不区分大小写
    if (seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}
