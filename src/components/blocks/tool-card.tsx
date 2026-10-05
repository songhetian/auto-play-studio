import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { Icon, type IconName } from '@/components/icon'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { fadeItem } from '@/lib/motion'
import { TOOL_GRID } from '@/components/blocks/toolGrid'
import { RHYTHM } from '@/components/blocks/rhythm'

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
    <motion.div variants={fadeItem} whileHover={{ y: -2 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }} className="h-full">
      <div
        className="group flex h-full flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition-shadow hover:border-border/80 hover:shadow-md"
        style={{ minHeight: TOOL_GRID.minCardHeight }}
      >
        <Link to={to} className="flex items-start gap-3">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm transition-transform group-hover:scale-[1.06]"
            style={{ background: color }}
          >
            <Icon name={icon} size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-base font-medium">{name}</span>
              {badge}
            </span>
            {/* 统一两行：说明一行或两行的卡片混排时，同排高度才不会参差 */}
            <span className="mt-1 line-clamp-2 block text-sm leading-relaxed text-muted-foreground">{desc}</span>
          </span>
        </Link>

        {footer}

        {/* mt-auto 把操作条压到卡片底部：无论上面内容多少，底边都在同一条线上 */}
        <div className="mt-auto flex items-center gap-2 border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">
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
    <motion.div variants={fadeItem} whileHover={{ y: -1 }} className="h-full">
      <Link
        to={to}
        className="group flex h-full items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:bg-accent/40"
        style={{ minHeight: TOOL_GRID.minCardHeight }}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground transition-colors group-hover:text-foreground">
          <Icon name={icon} size={17} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-base font-medium">{name}</span>
            {meta}
          </span>
          {/* 同样统一两行，与工具卡保持一致的文字节奏 */}
          <span className="mt-1 line-clamp-2 block text-sm leading-relaxed text-muted-foreground">{desc}</span>
        </span>
        <Icon name="chevronRight" size={15} className="mt-1 shrink-0 text-muted-foreground/60" />
      </Link>
    </motion.div>
  )
}

/** 工具箱分组标题：一条小标题 + 右侧说明，替代散落的 div 间距 */
export function ToolSectionHeader({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  return (
    <div className={RHYTHM.titleRow}>
      <h2 className="text-base font-medium">{title}</h2>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      <div className="flex-1" />
      {right}
    </div>
  )
}

export { Badge }
