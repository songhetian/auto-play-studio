import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon'
import { ipc, hasElectron } from '@/lib/ipc'
import {
  entriesFromDataTransfer,
  hasFileEntry,
  rootFoldersFrom,
  type DataTransferItemLike,
} from '@/lib/folderEntries'

/** `webkitdirectory` 不在 React 的 input 属性表里，只能这样透传 */
const DIR_INPUT_PROPS = { webkitdirectory: '' } as Record<string, string>

/**
 * 选一个**文件夹**来登记进知识库。
 *
 * ## 为什么不能靠拖拽拿路径
 *
 * 拖进来的目录，Chromium 只给 `webkitGetAsEntry()`，它的 `fullPath` 是
 * `/售后资料` 这种**虚拟路径**（没有盘符）；而 `getAsFile()` 对目录返回 null。
 * 浏览器出于安全也不把磁盘位置暴露给 JS。所以「拖进来 → 知道它在磁盘上的位置」
 * 这条路在渲染进程里根本走不通 —— 之前那版把 `/售后资料` 当路径登记进去了。
 *
 * 真路径只有两个来源：
 *  1. **系统目录选择器**（`ipc.selectFolder`，最直接）
 *  2. `<input type="file" webkitdirectory>` —— 每个 File 都带真实绝对路径
 *     （经 preload 的 `webUtils` / `file.path`）和 `webkitRelativePath`，
 *     两者一减就是所选文件夹的绝对路径
 *
 * 所以这里的交互是：点一下 → 选文件夹（拿到绝对路径）；拖进来 → 识别出是文件夹后
 * 直接把系统选择器打开，而不是假装拿到了路径。
 */
export function FolderDrop({ onFolders }: { onFolders: (paths: string[]) => void }) {
  const [over, setOver] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = (paths: string[]) => {
    if (paths.length) {
      setErr('')
      onFolders(paths)
    } else {
      setErr('没读到文件夹的路径，请用下面的输入框粘贴完整路径。')
    }
  }

  /** 选了文件夹：从 FileList 反推根目录的绝对路径 */
  const onPick = (files: FileList | null) => {
    const list = Array.from(files ?? [])
    if (!list.length) return
    const roots = rootFoldersFrom(
      list.map((f) => ({ absolutePath: ipc.getPathForFile(f), relativePath: f.webkitRelativePath ?? '' })),
    )
    if (roots.length) {
      submit(roots)
      return
    }
    // 浏览器预览态没有桥 → 拿不到绝对路径。把拿到的相对结构说清楚，别让用户猜
    const rel = list[0]?.webkitRelativePath ?? ''
    setErr(
      rel
        ? `只读到「${rel}」这样的相对路径，不是能用的绝对路径。桌面版这里能拿到完整路径；` +
          '现在请用下面的输入框粘贴文件夹的完整路径。'
        : '读不出文件夹的绝对路径，请用下面的输入框粘贴完整路径。',
    )
  }

  /** 拖进来：是文件夹就改走系统选择器（拿真路径），是文件直接说清楚 */
  const onDropped = async (items: DataTransferItemLike[]) => {
    const entries = entriesFromDataTransfer(items)
    if (!entries.length) {
      setErr('读不出拖进来的内容。点一下这里选文件夹最稳。')
      return
    }
    if (hasFileEntry(entries)) {
      setErr('知识库登记的是「文件夹」，拖进来的是文件。请拖文件夹，或用下面的路径输入框。')
      return
    }
    if (!hasElectron) {
      setErr('浏览器给不出文件夹的绝对路径，请用下面的输入框粘贴完整路径。')
      return
    }
    // 是文件夹：Chromium 只给虚拟路径，改用系统选择器拿绝对路径
    const picked = await ipc.selectFolder()
    if (picked) submit([picked])
    else setErr('已取消选择。也可以直接把完整路径粘到下面的输入框。')
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          inputRef.current?.click()
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        setErr('')
        const items = Array.from(e.dataTransfer.items ?? []) as unknown as DataTransferItemLike[]
        void onDropped(items)
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-center transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        over ? 'border-primary bg-primary/[0.06]' : 'border-border bg-muted/30 hover:bg-accent/40',
      )}
    >
      <span className={cn('flex size-8 items-center justify-center rounded-lg', over ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
        <Icon name={over ? 'download' : 'folder'} size={16} />
      </span>
      <span className="text-sm font-medium">点这里选资料文件夹</span>
      <span className="text-xs text-muted-foreground">可多选；把文件夹拖进来也行（会为你打开选择器）</span>
      {/* 真路径来源：preload 的 webUtils/file.path 给绝对路径，webkitRelativePath 给目录结构 */}
      <input
        {...DIR_INPUT_PROPS}
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          onPick(e.target.files)
          e.target.value = '' // 允许连续选同一个文件夹
        }}
      />
      {err && (
        <p className="mt-1 flex items-start gap-1.5 text-left text-xs leading-relaxed text-warn">
          <Icon name="warning" size={12} className="mt-0.5 flex-none" />
          <span>{err}</span>
        </p>
      )}
    </div>
  )
}
