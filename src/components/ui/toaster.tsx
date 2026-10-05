import { AnimatePresence, motion } from 'motion/react'
import { useToastStore } from '@/stores/toastStore'
import { Icon } from '@/components/icon'
import { cn } from '@/lib/utils'

/** 语气 → 图标与配色。取色沿用全局令牌（ok / destructive / primary / warn）。 */
const TONE = {
  success: { icon: 'success', bar: 'bg-ok', text: 'text-ok' },
  error: { icon: 'error', bar: 'bg-destructive', text: 'text-destructive' },
  info: { icon: 'info', bar: 'bg-primary', text: 'text-primary' },
  warning: { icon: 'warning', bar: 'bg-warn', text: 'text-warn' },
} as const

/**
 * 全局提醒层：右上角浮出、到点自己消失。
 *
 * 挂在 AppShell 顶层，任何页面、任何回调里 `toast.success(...)` 都能用。
 * 只做渲染 —— 排队、上限、定时这些逻辑在 `stores/toastStore`，那边有单测。
 */
export function Toaster() {
  const items = useToastStore((s) => s.items)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    <div className="pointer-events-none fixed right-4 top-16 z-[120] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      <AnimatePresence initial={false}>
        {items.map((t) => {
          const tone = TONE[t.tone]
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              role="status"
              className="pointer-events-auto relative flex items-start gap-2.5 overflow-hidden rounded-lg border border-border bg-card px-3.5 py-2.5 shadow-sm"
            >
              {/* 左侧一道细色条标明语气，不用把整块底色染上 */}
              <span className={cn('absolute inset-y-0 left-0 w-[3px]', tone.bar)} />
              <Icon name={tone.icon} size={15} className={cn('mt-0.5 flex-none', tone.text)} />
              <div className="min-w-0 flex-1 text-sm leading-relaxed">{t.message}</div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="-mr-1 -mt-0.5 flex-none rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                aria-label="关闭提醒"
              >
                <Icon name="close" size={13} />
              </button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
