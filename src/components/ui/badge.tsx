import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded font-medium transition-colors [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // 淡色：默认，用于「状态标签」（Arco tag 的浅底风格）
        default: 'border border-transparent bg-primary/10 px-1.5 py-0.5 text-xs text-primary',
        secondary: 'border border-transparent bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground',
        destructive: 'border border-transparent bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive',
        success: 'border border-transparent bg-ok/12 px-1.5 py-0.5 text-xs text-ok',
        warning: 'border border-transparent bg-warn/14 px-1.5 py-0.5 text-xs text-warn',
        // 实心：用于需要跳出底色的一眼可见标签（如「运行中」）
        solid: 'border border-transparent bg-primary px-1.5 py-0.5 text-xs text-primary-foreground',
        'solid-success':
          'border border-transparent bg-ok px-1.5 py-0.5 text-xs text-white',
        'solid-destructive':
          'border border-transparent bg-destructive px-1.5 py-0.5 text-xs text-destructive-foreground',
        outline: 'border border-border px-1.5 py-0.5 text-xs text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
