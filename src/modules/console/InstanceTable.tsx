import { useRef, useState } from 'react'
import { toolById } from '@/app/moduleRegistry'
import type { Instance } from '@/schemas/instance'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Icon } from '@/components/icon'
import { ConfirmDialog } from '@/components/blocks/confirm-dialog'
import { STATUS_TEXT, isLive, statusTone } from '@/modules/console/instanceStatus'
import { useInstanceActions, useOpenInstanceWindow } from '@/modules/console/useInstanceActions'
import { useInstanceControl } from '@/modules/console/useInstanceControl'
import { useRename } from '@/modules/console/useRename'

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
  const control = useInstanceControl()
  const rename = useRename()
  const openWindow = useOpenInstanceWindow()
  const [pendingDelete, setPendingDelete] = useState<Instance | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

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
                  {editingId === i.id ? (
                    <InlineRename
                      initial={i.name}
                      pending={rename.isPending}
                      onCancel={() => setEditingId(null)}
                      onSubmit={(name) => {
                        rename.mutate(
                          { id: i.id, name },
                          { onSettled: () => setEditingId(null) },
                        )
                      }}
                    />
                  ) : (
                    <>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void openWindow(i, 'run')}
                          title="打开运行详情"
                          className="truncate text-left font-medium text-foreground transition-colors hover:text-primary"
                        >
                          {i.name}
                        </button>
                        {/* 名字点铅笔就能改：实例名是用户自己起的，不该只能删掉重建 */}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-5 flex-none text-muted-foreground/70 hover:text-primary"
                          title="改名"
                          aria-label={`给实例 ${i.name} 改名`}
                          onClick={() => setEditingId(i.id)}
                        >
                          <Icon name="pencil" size={12} />
                        </Button>
                      </div>
                      <div className="mt-0.5 font-mono text-xs text-muted-foreground">{i.id}</div>
                    </>
                  )}
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
                      <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
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
                  <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                    <InstanceControlButton inst={i} control={control} />
                    {isLive(i.status) && i.status !== 'starting' && i.status !== 'stopping' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => control.mutate({ id: i.id, action: 'stop' })}
                        disabled={control.isPending}
                        title="停止当前这一轮"
                      >
                        <Icon name="stop" size={13} />
                        停止
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void openWindow(i, 'config')}
                      title="打开实例配置"
                    >
                      <Icon name="sliders" size={13} />
                      配置
                    </Button>
                    <Separator orientation="vertical" className="mx-0.5 h-4" />
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
        action="delete"
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

/**
 * 行内改名输入框。
 *
 * Enter 提交 / Esc 取消 / 失焦提交 —— 三个都要有：用户改名字时十有八九是随手敲完
 * 就想看结果，不该还要特意去点某个按钮。只在名字真的变了时才提交，空提交直接取消。
 */
function InlineRename({
  initial,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: string
  pending: boolean
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const doneRef = useRef(false)

  const commit = () => {
    // blur 与 Enter 可能连着触发，提交一次就够了
    if (doneRef.current) return
    const next = value.trim()
    if (!next || next === initial) {
      doneRef.current = true
      onCancel()
      return
    }
    doneRef.current = true
    onSubmit(next)
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        value={value}
        maxLength={60}
        disabled={pending}
        aria-label="实例新名字"
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            doneRef.current = true
            onCancel()
          }
        }}
      />
    </div>
  )
}

/**
 * 行内主控制按钮：按状态变脸，免得用户点进实例窗口才能开始 / 暂停 / 继续。
 * 启动中 / 停止中这类瞬时态禁用，避免重复下发。
 */
function InstanceControlButton({
  inst,
  control,
}: {
  inst: Instance
  control: ReturnType<typeof useInstanceControl>
}) {
  const { status, id } = inst
  const busy = status === 'starting' || status === 'stopping'

  if (busy) {
    return (
      <Button variant="ghost" size="sm" disabled title={STATUS_TEXT[status]}>
        <Icon name="refresh" size={13} className="animate-spin" />
        {STATUS_TEXT[status]}
      </Button>
    )
  }
  if (status === 'running') {
    return (
      <Button
        variant="default"
        size="sm"
        onClick={() => control.mutate({ id, action: 'pause' })}
        disabled={control.isPending}
        title="暂停（F9）"
      >
        <Icon name="pause" size={13} />
        暂停
      </Button>
    )
  }
  if (status === 'paused') {
    return (
      <Button
        variant="default"
        size="sm"
        onClick={() => control.mutate({ id, action: 'resume' })}
        disabled={control.isPending}
        title="继续（F9）"
      >
        <Icon name="play" size={13} />
        继续
      </Button>
    )
  }
  // idle / completed / error：开始
  return (
    <Button
      variant="default"
      size="sm"
      onClick={() => control.mutate({ id, action: 'start' })}
      disabled={control.isPending}
      title="开始执行（F8）"
    >
      <Icon name="play" size={13} />
      开始
    </Button>
  )
}
