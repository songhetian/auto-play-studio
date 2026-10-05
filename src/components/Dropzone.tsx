import { useRef, useState } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { Icon, type IconName } from '@/components/icon'
import { describeFiles, filterFiles, formatSize } from '@/lib/fileDrop'

/**
 * 拖拽 / 点击上传：Excel 入口、图片素材、自定义音频共用。
 *
 * 支持**多文件**：拖一批进来会全部处理，而不是只取第一个、其余静默消失
 * （`filterFiles` 会逐个说出被退回的文件与原因）。
 *
 * 两个回调刻意并存：
 *  - `onFile(f)` 单个文件 —— 既有调用点不用改
 *  - `onFiles(list)` 批量 —— 需要处理多个文件的调用点用（素材库、知识库）
 * 两个都不传会静默失败，所以至少要传一个。
 */
export function Dropzone({
  onFile,
  onFiles,
  hint,
  accept = '.xlsx,.xlsm',
  icon = 'sheet',
  title,
  compact,
  multiple = false,
  maxSize,
  className,
}: {
  /** 单个文件（便捷回调；与 onFiles 同时传时两个都会收到） */
  onFile?: (f: File) => void
  /** 批量文件 */
  onFiles?: (files: File[]) => void
  hint?: React.ReactNode
  accept?: string
  icon?: IconName
  title?: React.ReactNode
  compact?: boolean
  /** 是否允许多选/多拖。批量场景打开 */
  multiple?: boolean
  /** 单文件大小上限（字节） */
  maxSize?: number
  className?: string
}) {
  const [over, setOver] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handle = (files: FileList | File[] | null) => {
    if (!files || !Array.from(files).length) return
    const r = filterFiles(files, accept, maxSize)
    if (r.accepted.length) {
      onFile?.(r.accepted[0])
      onFiles?.(r.accepted)
    }
    // 有退回文件时必须说出来：静默丢弃会让人以为"文件传上去了"
    if (r.rejected.length) setNote({ tone: 'warn', text: describeFiles(r) })
    else if (multiple) setNote({ tone: 'ok', text: describeFiles(r) })
  }

  const acceptedList = accept.split(',').map((s) => s.trim()).filter(Boolean)

  return (
    <div className={className}>
      <motion.div
        animate={{ scale: over ? 1.005 : 1 }}
        transition={{ duration: 0.15 }}
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
          // 拖文件夹时 dataTransfer.items 里有条目但 files 可能为空，
          // 这种情况直接告诉用户"不支持拖文件夹"，比无声失败好
          const dt = e.dataTransfer
          if (!dt.files.length && dt.items.length) {
            setNote({ tone: 'warn', text: '拖进来的是文件夹，请拖文件本身' })
            return
          }
          handle(dt.files)
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed text-center transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          compact ? 'gap-1 px-4 py-4' : 'gap-2 px-6 py-8',
          over ? 'border-primary bg-primary/[0.06]' : 'border-border bg-muted/30 hover:border-muted-foreground/40 hover:bg-accent/40',
        )}
      >
        <span
          className={cn(
            'flex items-center justify-center rounded-lg transition-colors',
            compact ? 'size-7' : 'size-9',
            over ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon name={over ? 'download' : icon} size={compact ? 14 : 17} />
        </span>
        <span className={cn('font-medium', compact ? 'text-sm' : 'text-base')}>
          {title ?? (multiple ? '把文件拖到这里，或点击选择（可多选）' : '拖拽文件到此处，或点击选择')}
        </span>
        <span className="text-xs text-muted-foreground">
          支持 {acceptedList.join(' / ')}
          {maxSize ? ` · 单个不超过 ${formatSize(maxSize)}` : ''}
          {hint ? ` · ${hint}` : ''}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          className="hidden"
          onChange={(e) => {
            handle(e.target.files)
            // 清空 value：否则连续选同一个文件不会再触发 change
            e.target.value = ''
          }}
        />
      </motion.div>

      {note && (
        <p
          className={cn(
            'mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed',
            note.tone === 'warn' ? 'text-warn' : 'text-muted-foreground',
          )}
        >
          <Icon name={note.tone === 'warn' ? 'warning' : 'success'} size={12} className="mt-0.5 flex-none" />
          <span>{note.text}</span>
        </p>
      )}
    </div>
  )
}
