import { useState } from 'react'
import { toolById } from '@/app/moduleRegistry'
import type { Instance } from '@/schemas/instance'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Icon } from '@/components/icon'
import { ConfirmDialog } from '@/components/blocks/confirm-dialog'
import { STATUS_TEXT, statusTone } from '@/modules/console/instanceStatus'
import { openInstanceWindow, useInstanceActions } from '@/modules/console/useInstanceActions'

const TONE_VARIANT = {
  ok: 'success',
  err: 'destructive',
  warn: 'warning',
  neutral: 'secondary',
} as const

/**
 * 实例表格：总览、实例管理、工具落地页三处共用一份列定义与操作口径，
 * 避免同一个「删除」在不同页面行为不一致。
 *
 * empty 由调用方给：空列表在不同页面该指向不同的下一步，
 * 「暂无实例」这种放之四海的文案等于什么都没说。
 */
export function InstanceTable({
  list,
  showTool = true,
}: {
  list: Instance[]
  showTool?: boolean
}) {
  const { clone, remove } = useInstanceActions()
  const [pendingDelete, setPendingDelete] = useState<Instance | null>(null)

  if (!list.length) return null

  return (
    <>
      <Table className={showTool ? 'min-w-[800px]' : 'min-w-[680px]'}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>实例</TableHead>
            {showTool && <TableHead className="w-[140px]">工具</TableHead>}
            <TableHead className="w-[96px]">状态</TableHead>
            <TableHead className="w-[150px]">进度</TableHead>
            <TableHead className="w-[212px] text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((i) => {
            const pct = i.total ? Math.round((i.done / i.total) * 100) : 0
            return (
              <TableRow key={i.id}>
                <TableCell>
                  <div className="font-medium">{i.name}</div>
                  <div className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">{i.id}</div>
                </TableCell>
                {showTool && (
                  <TableCell>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="flex size-4 flex-none items-center justify-center rounded text-white"
                        style={{ background: toolById(i.tool).color }}
                      >
                        <Icon name={toolById(i.tool).icon} size={10} />
                      </span>
                      <span className="truncate">{toolById(i.tool).name}</span>
                    </span>
                  </TableCell>
                )}
                <TableCell>
                  <Badge variant={TONE_VARIANT[statusTone(i.status)]} className="gap-1.5">
                    <span
                      className={cn(
                        'size-1.5 rounded-full bg-current',
                        (i.status === 'running' || i.status === 'starting') && 'animate-pulse',
                      )}
                    />
                    {STATUS_TEXT[i.status]}
                  </Badge>
                </TableCell>
                <TableCell>
                  {i.total ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
                        <span className="tabular-nums">
                          {i.done} / {i.total}
                        </span>
                        <span className="ml-auto tabular-nums">{pct}%</span>
                      </div>
                      <Progress value={pct} />
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-0.5 whitespace-nowrap">
                    <Button variant="ghost" size="sm" onClick={() => openInstanceWindow(i, 'run')}>
                      <Icon name="activity" size={13} />
                      运行
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openInstanceWindow(i, 'config')}>
                      <Icon name="sliders" size={13} />
                      配置
                    </Button>
                    <Separator orientation="vertical" className="mx-1 h-4" />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="复制实例"
                      aria-label="复制实例"
                      onClick={() => clone.mutate(i.id)}
                      disabled={clone.isPending}
                    >
                      <Icon name="copy" size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="删除实例"
                      aria-label="删除实例"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setPendingDelete(i)}
                    >
                      <Icon name="trash" size={13} />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(v) => !v && setPendingDelete(null)}
        icon="trash"
        destructive
        title={`删除实例「${pendingDelete?.name ?? ''}」？`}
        desc="实例的配置与运行记录会一起删除，该操作不可撤销。"
        confirmText="删除"
        pending={remove.isPending}
        onConfirm={() => {
          if (!pendingDelete) return
          remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) })
        }}
      />
    </>
  )
}
