import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** 快捷键提示：等宽、描边，用来在文案里嵌入 F9 / ⌘S 这类按键 */
function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        // 上边缘高光 + 下边缘暗线：让按键看起来是「立起来的实体」，而不是一个灰底方块
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border bg-muted px-1.5',
        'font-mono text-2xs font-medium leading-none text-muted-foreground',
        'shadow-[inset_0_1px_0_hsl(var(--foreground)/.06),0_1px_1px_hsl(var(--foreground)/.05)]',
        className,
      )}
      {...props}
    />
  )
}

export { Kbd }
