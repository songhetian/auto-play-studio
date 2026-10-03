import * as React from 'react'
import { cn } from '@/lib/utils'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      'flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-[13px] shadow-sm transition-colors',
      'placeholder:text-muted-foreground',
      'file:border-0 file:bg-transparent file:text-[13px] file:font-medium',
      'focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25',
      'disabled:cursor-not-allowed disabled:opacity-55',
      className,
    )}
    {...props}
  />
))
Input.displayName = 'Input'

export { Input }
