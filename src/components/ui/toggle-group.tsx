import * as React from 'react'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const toggleGroupVariants = cva('inline-flex items-center justify-center rounded-lg p-0.5 bg-muted', {
  variants: {
    size: {
      default: 'h-8',
      sm: 'h-7',
    },
  },
  defaultVariants: { size: 'default' },
})

const toggleGroupItemVariants = cva(
  cn(
    'inline-flex flex-1 items-center justify-center gap-1.5 rounded-[6px] text-muted-foreground transition-colors',
    'hover:text-foreground',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
    'disabled:pointer-events-none disabled:opacity-50',
    'data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm data-[state=on]:font-medium',
    '[&_svg]:size-3.5 [&_svg]:shrink-0',
  ),
  {
    variants: {
      size: {
        default: 'h-7 px-3 text-[12.5px]',
        sm: 'h-6 px-2.5 text-[12px]',
      },
    },
    defaultVariants: { size: 'default' },
  },
)

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root> & VariantProps<typeof toggleGroupVariants>
>(({ className, size, children, ...props }, ref) => (
  <ToggleGroupPrimitive.Root ref={ref} className={cn(toggleGroupVariants({ size }), className)} {...props}>
    {children}
  </ToggleGroupPrimitive.Root>
))
ToggleGroup.displayName = ToggleGroupPrimitive.Root.displayName

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleGroupItemVariants>
>(({ className, size, ...props }, ref) => (
  <ToggleGroupPrimitive.Item ref={ref} className={cn(toggleGroupItemVariants({ size }), className)} {...props} />
))
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName

export { ToggleGroup, ToggleGroupItem }
