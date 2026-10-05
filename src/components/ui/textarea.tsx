import * as React from 'react'
import { cn } from '@/lib/utils'

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** 校验错误态：边框转红 + 红色聚焦光环 */
  error?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, error, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-[72px] w-full rounded-md border bg-background px-3 py-2 text-base shadow-sm transition-all duration-150',
      'placeholder:text-muted-foreground',
      'border-input hover:border-foreground/30',
      'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20',
      'disabled:cursor-not-allowed disabled:opacity-55',
      error && 'border-destructive hover:border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20',
      className,
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'

export { Textarea }
