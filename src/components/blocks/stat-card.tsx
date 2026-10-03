import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Icon, type IconName } from '@/components/icon'
import { fadeItem } from '@/lib/motion'

type Tone = 'default' | 'ok' | 'warn' | 'err' | 'brand'

const TONE: Record<Tone, { value: string; chip: string }> = {
  default: { value: 'text-foreground', chip: 'bg-muted text-muted-foreground' },
  ok: { value: 'text-[hsl(var(--ok))]', chip: 'bg-[hsl(var(--ok)/0.12)] text-[hsl(var(--ok))]' },
  warn: { value: 'text-[hsl(var(--warn))]', chip: 'bg-[hsl(var(--warn)/0.14)] text-[hsl(var(--warn))]' },
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
          <span className="text-[12px] text-muted-foreground">{label}</span>
        </div>
        <div className={cn('mt-2.5 font-mono text-[24px] leading-none tracking-tight tabular-nums', t.value)}>{value}</div>
        {hint && <div className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">{hint}</div>}
      </Card>
    </motion.div>
  )
}
