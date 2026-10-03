import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'

/**
 * 表单一行：标签 / 控件 / 辅助说明三段式。
 *
 * 说明文字放在控件**下方**（而不是右侧或 Tooltip 里），因为配置类工具里
 * 「这个值填什么」几乎总需要解释，藏起来等于没写。
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
  inline,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
  /** 标签与控件左右排：用在短控件（开关、下拉）上，长控件请用默认的上下排 */
  inline?: boolean
}) {
  return (
    <div className={cn(inline ? 'flex items-center justify-between gap-4' : 'space-y-1.5', className)}>
      <div className={cn(inline && 'min-w-0')}>
        <Label htmlFor={htmlFor}>{label}</Label>
        {inline && hint && <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className={cn(inline && 'shrink-0')}>
        {children}
        {!inline && hint && !error && <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">{hint}</p>}
        {error && <p className="mt-1.5 text-[11.5px] leading-relaxed text-destructive">{error}</p>}
      </div>
    </div>
  )
}
