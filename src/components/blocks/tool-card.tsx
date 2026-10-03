import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { Icon, type IconName } from '@/components/icon'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { fadeItem } from '@/lib/motion'

/**
 * 工具箱格子：一个工具 = 一格。
 *
 * 结构固定为「彩色图标块 + 名称 + 一句话说明 + 底部操作条」，
 * 保证 4 个工具、以及将来新增的工具，视觉节奏完全一致。
 * 整格可点（进工具页），右下角的「新建」是直接的快路径。
 */
export function ToolCard({
  to,
  name,
  desc,
  color,
  icon,
  count,
  footer,
  badge,
  pending,
  onPrimary,
  primaryText = '新建',
}: {
  to: string
  name: string
  desc: string
  color: string
  icon: IconName
  count?: number
  footer?: ReactNode
  badge?: ReactNode
  pending?: boolean
  onPrimary?: () => void
  primaryText?: string
}) {
  return (
    <motion.div variants={fadeItem} whileHover={{ y: -2 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
      <div className="group flex h-full flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition-shadow hover:border-border/80 hover:shadow-md">
        <Link to={to} className="flex items-start gap-3">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm transition-transform group-hover:scale-[1.06]"
            style={{ background: color }}
          >
            <Icon name={icon} size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[13.5px] font-medium">{name}</span>
              {badge}
            </span>
            <span className="mt-1 block text-[12px] leading-relaxed text-muted-foreground">{desc}</span>
          </span>
        </Link>

        {footer}

        <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
          <span className="text-[11.5px] text-muted-foreground">
            {count === undefined ? '' : count > 0 ? `${count} 个实例` : '还没有实例'}
          </span>
          <div className="flex-1" />
          {onPrimary && (
            <Button
              size="sm"
              variant={count ? 'outline' : 'default'}
              onClick={onPrimary}
              disabled={pending}
              className={cn('opacity-90 group-hover:opacity-100')}
            >
              <Icon name={count ? 'plus' : 'rocket'} size={13} />
              {primaryText}
            </Button>
          )}
        </div>
      </div>
    </motion.div>
  )
}

/** 工具箱里非工具的入口（素材库、设置）：同款尺寸，弱一档的视觉 */
export function UtilityCard({
  to,
  name,
  desc,
  icon,
  meta,
}: {
  to: string
  name: string
  desc: string
  icon: IconName
  meta?: ReactNode
}) {
  return (
    <motion.div variants={fadeItem} whileHover={{ y: -1 }}>
      <Link
        to={to}
        className="group flex h-full items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:bg-accent/40"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground transition-colors group-hover:text-foreground">
          <Icon name={icon} size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium">{name}</span>
            {meta}
          </span>
          <span className="mt-1 block text-[12px] leading-relaxed text-muted-foreground">{desc}</span>
        </span>
        <Icon name="chevronRight" size={15} className="mt-1 shrink-0 text-muted-foreground/60" />
      </Link>
    </motion.div>
  )
}

/** 工具箱分组标题：一条小标题 + 右侧说明，替代散落的 div 间距 */
export function ToolSectionHeader({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  return (
    <div className="flex items-end gap-3">
      <h2 className="text-[13px] font-medium">{title}</h2>
      {hint && <span className="text-[11.5px] text-muted-foreground">{hint}</span>}
      <div className="flex-1" />
      {right}
    </div>
  )
}

export { Badge }
