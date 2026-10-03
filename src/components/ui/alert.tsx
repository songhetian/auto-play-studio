import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const alertVariants = cva(
  'relative w-full rounded-lg border px-4 py-3 text-[13px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:size-4 [&>svg~*]:pl-7',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        info: 'border-border bg-muted/60 text-foreground',
        warning: 'border-[hsl(var(--warn)/0.35)] bg-[hsl(var(--warn)/0.1)] text-[hsl(var(--warn))] [&>svg]:text-[hsl(var(--warn))]',
        destructive: 'border-destructive/35 bg-destructive/10 text-destructive [&>svg]:text-destructive',
        success: 'border-[hsl(var(--ok)/0.35)] bg-[hsl(var(--ok)/0.1)] text-[hsl(var(--ok))] [&>svg]:text-[hsl(var(--ok))]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

const Alert = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
  ),
)
Alert.displayName = 'Alert'

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5 ref={ref} className={cn('mb-1 text-[13px] font-medium leading-none tracking-tight', className)} {...props} />
  ),
)
AlertTitle.displayName = 'AlertTitle'

const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-[12.5px] leading-relaxed [&_p]:leading-relaxed', className)} {...props} />
  ),
)
AlertDescription.displayName = 'AlertDescription'

export { Alert, AlertTitle, AlertDescription }
