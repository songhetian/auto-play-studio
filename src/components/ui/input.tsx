import * as React from 'react'
import { cn } from '@/lib/utils'
import { ERROR_CLS, FIELD_BASE, inputPadding, inputTypo } from './inputMetrics'

export type InputSize = 'sm' | 'default' | 'lg'

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  /** 校验错误态：边框转红 + 红色聚焦光环（Arco Input error） */
  error?: boolean
  size?: InputSize
  /** 前置内容（图标/文字），传入后自动包一层容器渲染在框内左侧 */
  prefix?: React.ReactNode
  /** 后置内容（图标/清空按钮/单位），渲染在框内右侧 */
  suffix?: React.ReactNode
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, error, size = 'default', prefix, suffix, ...props }, ref) => {
    // 无前后缀：维持原来的单层 <input> DOM，完全向后兼容。
    // 内边距走 inputPadding —— 裸 input 在 Tailwind 预检下没有任何 padding，
    // 不显式给就是文字贴左边框（用户反馈"输入框局容"）。
    if (!prefix && !suffix) {
      return (
        <input
          type={type}
          ref={ref}
          className={cn(FIELD_BASE, inputTypo(size), inputPadding(size), error && ERROR_CLS, className)}
          {...props}
        />
      )
    }
    // 有前后缀：包一层容器，内层仍是 <input>，聚焦光环挂在容器上
    return (
      <div
        className={cn(FIELD_BASE, inputTypo(size), inputPadding(size), error && ERROR_CLS, 'gap-1.5')}
      >
        {prefix && <span className="flex-none text-muted-foreground">{prefix}</span>}
        <input
          ref={ref}
          type={type}
          className={cn(
            'h-full w-full min-w-0 flex-1 bg-transparent outline-none',
            'placeholder:text-muted-foreground disabled:cursor-not-allowed',
            className,
          )}
          {...props}
        />
        {suffix && <span className="flex-none text-muted-foreground">{suffix}</span>}
      </div>
    )
  },
)
Input.displayName = 'Input'

export { Input }