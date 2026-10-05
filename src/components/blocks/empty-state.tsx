import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Icon, type IconName } from '@/components/icon'

/**
 * 空态：必须说清「为什么空」和「下一步点哪」。
 * 只写「暂无数据」的空态等于没说，所以 actions 是常规配置而不是可选项。
 */
export function EmptyState({
  icon = 'boxes',
  title,
  desc,
  actions,
  className,
}: {
  icon?: IconName
  title: ReactNode
  desc?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-muted/60 text-muted-foreground">
        <Icon name={icon} size={20} />
      </span>
      <div className="mt-3 text-base font-medium">{title}</div>
      {desc && <div className="mt-1 max-w-[46ch] text-sm leading-relaxed text-muted-foreground">{desc}</div>}
      {actions && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  )
}
