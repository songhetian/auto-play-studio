import type { ReactNode } from 'react'
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

/**
 * 确认弹窗：所有「会改数据」的动作都走它，避免每个页面各写一套遮罩 div。
 *
 * 分工固定为「标题说结论 → 正文说影响 → 底部给两个按钮」，
 * 危险动作的主按钮是红的且默认不聚焦，防手滑回车。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  desc,
  children,
  confirmText = '确认',
  cancelText = '取消',
  destructive,
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
  destructive?: boolean
  pending?: boolean
  icon?: IconName
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {icon && (
              <span
                className={
                  destructive
                    ? 'flex size-6 items-center justify-center rounded-md bg-destructive/10 text-destructive'
                    : 'flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary'
                }
              >
                <Icon name={icon} size={14} />
              </span>
            )}
            {title}
          </DialogTitle>
          {desc && <DialogDescription>{desc}</DialogDescription>}
        </DialogHeader>

        {children}

        <DialogFooter>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={pending}>
            {pending && <Icon name="refresh" size={13} className="animate-spin" />}
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
