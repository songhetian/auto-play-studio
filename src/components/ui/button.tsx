import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const spinner = <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />

const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-all duration-150 select-none',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
    'disabled:pointer-events-none disabled:opacity-50 active:scale-[.98]',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        // 主要按钮：品牌填充，扁平无阴影，悬停靠背景色深浅反馈
        default: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/85',
        // 次按钮：浅灰填充，比描边更安静
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/70',
        // 次次按钮（描边）：悬停浅填充
        outline: 'border border-input bg-background text-foreground hover:border-ring/60 hover:bg-accent hover:text-accent-foreground',
        // 文字按钮：无底色，悬停浅填充
        ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
        // 虚线按钮：用于「新增/导入」等次级动作，Arco 的 dashed
        dashed: 'border border-dashed border-input bg-background text-foreground hover:border-ring/60 hover:bg-accent',
        // 链接按钮
        link: 'text-primary underline-offset-4 hover:underline',
        // 危险/删除：复用 destructive，danger 作为同义别名
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/85',
        danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/85',
        success: 'bg-ok text-white hover:opacity-90 active:opacity-100',
        warning: 'bg-warn text-white hover:opacity-90 active:opacity-100',
      },
      size: {
        default: 'h-8 px-3.5 text-base',
        sm: 'h-7 px-3 text-sm',
        lg: 'h-9 px-5 text-base',
        icon: 'h-8 w-8',
        'icon-sm': 'h-7 w-7',
      },
      // 形状：圆角(square) / 胶囊(round) / 正圆(circle，用于纯图标按钮)
      shape: {
        square: '',
        round: 'rounded-full',
        circle: 'rounded-full p-0 aspect-square',
      },
    },
    defaultVariants: { variant: 'default', size: 'default', shape: 'square' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /** 加载态：显示旋转指示器并禁用点击（Arco Button loading） */
  loading?: boolean
  /** 撑满整行（Arco Button long） */
  long?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, shape, asChild = false, loading = false, long = false, disabled, children, ...props }, ref) => {
    // asChild 时必须把 children 原样透传给 Slot：
    // Slot 只接受「单个 React 元素」，多包一层（哪怕只是一个 false 或一个 Fragment）
    // 都会抛 "Slot failed to slot onto its children" 并让整棵子树白屏。
    if (asChild) {
      return (
        <Slot
          className={cn(buttonVariants({ variant, size, shape }), long && 'w-full', className)}
          ref={ref}
          aria-busy={loading || undefined}
          {...props}
        >
          {children}
        </Slot>
      )
    }
    return (
      <button
        className={cn(buttonVariants({ variant, size, shape }), long && 'w-full', className)}
        disabled={disabled || loading}
        ref={ref}
        {...props}
      >
        {loading && spinner}
        {children}
      </button>
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
