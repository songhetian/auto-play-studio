import { useEffect, type ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Icon, type IconName } from '@/components/icon'
import { DIALOG_TONE, dialogShellClass, dialogToneOf, type DialogToneId } from '@/components/blocks/dialogTone'
import { cn } from '@/lib/utils'

/**
 * 确认弹窗：所有「需要用户拍板」的动作都走它。
 *
 * 按**语义**分四种呈现（见 `dialogTone.ts`）：
 *  - `danger` 删数据/注销 → 红色强调带 + 红色主按钮 + **拦回车**（手滑 = 删掉）
 *  - `warn`   覆盖/清理 → 琥珀强调带
 *  - `info`   常规确认 → 品牌色点缀，中性
 *  - `form`   表单输入 → 品牌色，主按钮在右
 *
 * 分工固定为「标题说结论 → 正文说影响 → 底部给两个按钮」。
 * 调用方给 `action`（如 `delete`）即可自动拿到合适的语气，也可显式传 `tone` 覆盖。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  desc,
  children,
  confirmText = '确认',
  cancelText = '取消',
  /** 危险动作：保留这个 prop 向后兼容（等价于 action="delete"） */
  destructive,
  action,
  tone,
  pending,
  icon,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: ReactNode
  desc?: ReactNode
  children?: ReactNode
  confirmText?: string
  cancelText?: string
  /** @deprecated 传 action="delete" 更有表达力；保留仅为兼容既有调用点 */
  destructive?: boolean
  /** 动作名（如 delete/clear/apply），决定弹窗的语义语气 */
  action?: string
  /** 显式指定语气，优先于 action 推断 */
  tone?: DialogToneId
  pending?: boolean
  icon?: IconName
  onConfirm: () => void
}) {
  // destructive 优先当 danger —— 既有调用点只传了它，不能让它们退化成中性色
  const toneId: DialogToneId = dialogToneOf({ action: destructive ? 'delete' : action, tone })
  const t = DIALOG_TONE[toneId]
  const isDanger = toneId === 'danger'

  // 危险类拦回车：表单里回车提交是常态，删除按钮上回车却不该直接生效
  useEffect(() => {
    if (!open || !t.guardEnter) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !pending) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, t.guardEnter, pending])

  const iconName = icon ?? t.icon
  const iconToneClass =
    t.iconTone === 'danger'
      ? 'bg-destructive/10 text-destructive'
      : t.iconTone === 'warn'
        ? 'bg-warn/14 text-warn'
        : 'bg-primary/10 text-primary'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(dialogShellClass(toneId), 'sm:max-w-[460px]')}>
        <DialogHeader className="gap-2 p-5 pb-4">
          <DialogTitle className="flex items-center gap-2.5 pr-8">
            <span className={cn('flex size-8 flex-none items-center justify-center rounded-lg', iconToneClass)}>
              <Icon name={iconName} size={17} />
            </span>
            <span className="flex-1">{title}</span>
            {t.label && (
              <span
                className={cn(
                  'flex-none rounded px-1.5 py-0.5 text-xs font-medium',
                  t.id === 'danger'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-warn/14 text-warn',
                )}
              >
                {t.label}
              </span>
            )}
          </DialogTitle>
          {desc && <DialogDescription className="pl-[42px] leading-relaxed">{desc}</DialogDescription>}
        </DialogHeader>

        {children && <div className="px-5 pb-1">{children}</div>}

        <DialogFooter className="gap-2 border-t border-border bg-muted/40 px-5 py-3">
          <Button
            variant={isDanger ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={pending}
            loading={pending}
          >
            {confirmText}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
