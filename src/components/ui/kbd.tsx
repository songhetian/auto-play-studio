import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** 快捷键提示：等宽、描边，用来在文案里嵌入 F9 / ⌘S 这类按键 */
function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5',
        'font-mono text-[11px] leading-none text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export { Kbd }
