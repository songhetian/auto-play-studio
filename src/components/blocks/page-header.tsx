import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { Icon, type IconName } from '@/components/icon'
import { fadeUp } from '@/lib/motion'

/**
 * 页面抬头：标题 + 一句话说明 + 右侧动作区。
 *
 * 标题字号克制在 16px、字重 medium —— 桌面工具里靠「位置和留白」建立层级，
 * 靠粗体和巨型字号只会让每页都像营销落地页。
 */
export function PageHeader({
  title,
  desc,
  actions,
  icon,
  className,
}: {
  title: ReactNode
  desc?: ReactNode
  actions?: ReactNode
  icon?: IconName
  className?: string
}) {
  return (
    <motion.div variants={fadeUp} className={cn('flex items-start gap-3 flex-wrap', className)}>
      {icon && (
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon name={icon} size={17} />
        </span>
      )}
      <div className="min-w-0">
        <h1 className="text-[16px] font-medium leading-tight tracking-tight">{title}</h1>
        {desc && <p className="mt-1 max-w-[62ch] text-[12.5px] leading-relaxed text-muted-foreground">{desc}</p>}
      </div>
      <div className="flex-1" />
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </motion.div>
  )
}
