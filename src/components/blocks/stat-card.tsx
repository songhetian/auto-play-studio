import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Icon, type IconName } from '@/components/icon'
import { fadeItem } from '@/lib/motion'

type Tone = 'default' | 'ok' | 'warn' | 'err' | 'brand'

const TONE: Record<Tone, { value: string; chip: string }> = {
  default: { value: 'text-foreground', chip: 'bg-muted text-muted-foreground' },
  ok: { value: 'text-ok', chip: 'bg-ok/12 text-ok' },
  warn: { value: 'text-warn', chip: 'bg-warn/14 text-warn' },
  err: { value: 'text-destructive', chip: 'bg-destructive/10 text-destructive' },
  brand: { value: 'text-primary', chip: 'bg-primary/10 text-primary' },
}

/**
 * 指标卡：数字是主角，标签退到次要位置。
 * 选中态只在「有异常」时才染红/染橙，平时保持中性，避免一屏全是彩色数字。
 */
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  icon,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: Tone
  icon?: IconName
}) {
  const t = TONE[tone]
  return (
    <motion.div variants={fadeItem}>
      <Card className="p-4">
        <div className="flex items-center gap-2">
          {icon && (
            <span className={cn('flex size-6 items-center justify-center rounded-md', t.chip)}>
              <Icon name={icon} size={13} />
            </span>
          )}
          <span className="text-sm text-muted-foreground">{label}</span>
        </div>
        <div className={cn('mt-2.5 font-mono text-xl leading-none tracking-tight tabular-nums', t.value)}>{value}</div>
        {hint && <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{hint}</div>}
      </Card>
    </motion.div>
  )
}
