import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'

/**
 * 表单一行：标签 / 控件 / 辅助说明三段式（Arco Form.Item 布局）。
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
  /** 必填：标签后加红色星标（Arco required） */
  required,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
  /** 标签与控件左右排：用在短控件（开关、下拉）上，长控件请用默认的上下排 */
  inline?: boolean
  required?: boolean
}) {
  return (
    <div className={cn(inline ? 'flex items-start justify-between gap-4' : 'space-y-1.5', className)}>
      <div className={cn(inline && 'min-w-0 pt-1.5')}>
        <Label htmlFor={htmlFor} className="text-base font-medium text-foreground/90">
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
        {inline && hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className={cn(inline && 'shrink-0')}>
        {children}
        {!inline && hint && !error && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
        {error && <p className="mt-1.5 flex items-center gap-1 text-xs leading-relaxed text-destructive">{error}</p>}
      </div>
    </div>
  )
}
