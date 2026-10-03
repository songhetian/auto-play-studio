import { useRef, useState } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { Icon, type IconName } from '@/components/icon'

/**
 * 拖拽 / 点击上传：各 Excel 入口共用（扩展名可配，对比表只吃 .xlsx/.xlsm）。
 *
 * 拖拽态用边框 + 底色 + 图标三者同时变化来表达，不要只换底色 ——
 * 深色主题下单纯换底色几乎看不出来。
 */
export function Dropzone({
  onFile,
  hint,
  accept = '.xlsx,.xls,.csv',
  icon = 'sheet',
  title,
  compact,
  className,
}: {
  onFile: (f: File) => void
  hint?: string
  accept?: string
  icon?: IconName
  title?: string
  compact?: boolean
  className?: string
}) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const allowed = accept.split(',').map((s) => s.trim().replace('.', '').toLowerCase())
  const acceptFile = (f?: File) => {
    if (!f) return
    const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
    if (!allowed.includes(ext)) return
    onFile(f)
  }

  return (
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
        acceptFile(e.dataTransfer.files?.[0])
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed text-center transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        compact ? 'gap-1 px-4 py-4' : 'gap-2 px-6 py-8',
        over ? 'border-primary bg-primary/[0.06]' : 'border-border bg-muted/30 hover:border-muted-foreground/40 hover:bg-accent/40',
        className,
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
      <span className={cn('font-medium', compact ? 'text-[12.5px]' : 'text-[13.5px]')}>
        {title ?? '拖拽 Excel 文件到此处，或点击选择文件'}
      </span>
      <span className="text-[11.5px] text-muted-foreground">
        支持 {accept.split(',').join(' / ')}
        {hint ? ` · ${hint}` : ''}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          acceptFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </motion.div>
  )
}
