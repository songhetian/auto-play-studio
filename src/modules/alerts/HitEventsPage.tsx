import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Icon } from '@/components/icon'
import { EmptyState } from '@/components/blocks/empty-state'
import { PageHeader } from '@/components/blocks/page-header'
import { api } from '@/lib/api'
import { useInstanceStore } from '@/stores/instanceStore'
import { useInstances } from '@/modules/console/useInstances'
import { matchedByLabel, notifiedHasIssue, notifiedText, type HitEvent } from '@/lib/hitEvents'

const ALL = 'all'
const PAGE = 20

const LEVEL_LABEL: Record<string, string> = { info: '信息', warn: '注意', alert: '要处理' }
const LEVEL_VARIANT: Record<string, 'secondary' | 'warning' | 'destructive'> = {
  info: 'secondary',
  warn: 'warning',
  alert: 'destructive',
}

/**
 * 命中事件：所有工具的命中都记在这里，跨实例可检索。
 *
 * 监控是常驻盯屏的，人不可能一直看着窗口 —— 这个页面回答的是
 * 「我走开这段时间命中了什么、通知出去没有」。
 */
export default function HitEventsPage() {
  const qc = useQueryClient()
  const instances = useInstanceStore((s) => s.instances)
  useInstances()

  const [instanceId, setInstanceId] = useState(ALL)
  const [tool, setTool] = useState(ALL)
  const [level, setLevel] = useState(ALL)
  const [unreadOnly, setUnreadOnly] = useState(false)
  /** 翻页游标栈：游标只能往后走，「上一页」靠回退栈顶 */
  const [cursors, setCursors] = useState<number[]>([])

  const filters = {
    instanceId: instanceId === ALL ? undefined : instanceId,
    tool: tool === ALL ? undefined : tool,
    level: level === ALL ? undefined : level,
    unreadOnly: unreadOnly || undefined,
    limit: PAGE,
    beforeId: cursors.length ? cursors[cursors.length - 1] : undefined,
  }
  const filterKey = JSON.stringify(filters)

  const query = useQuery({
    queryKey: ['hit-events', filterKey],
    queryFn: () => api.hitEvents(filters),
  })
  const unread = useQuery({ queryKey: ['hit-unread'], queryFn: api.hitUnreadCount })

  const markAll = useMutation({
    mutationFn: () => api.markHitsRead([]),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hit-events'] })
      qc.invalidateQueries({ queryKey: ['hit-unread'] })
    },
  })

  const events = query.data ?? []
  const nameOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const i of Object.values(instances)) map.set(i.id, i.name)
    return map
  }, [instances])

  const goNext = () => {
    const last = events[events.length - 1]
    if (last) setCursors((c) => [...c, last.id])
  }
  const goPrev = () => setCursors((c) => c.slice(0, -1))
  const resetPaging = () => setCursors([])

  const changeFilter = (fn: () => void) => {
    fn()
    resetPaging()
  }

  return (
    <div className="mx-auto max-w-[1240px] space-y-4 p-5">
      <PageHeader
        icon="bell"
        title="命中事件"
        desc="所有工具的命中记录，跨实例可检索；通知发没发出去、为什么没发出去，都写在每一条上"
        actions={
          <>
            <span className="text-[12px] text-muted-foreground">
              未读 {unread.data?.count ?? 0} 条
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={!unread.data?.count || markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              <Icon name="check" size={14} />
              全部标记已读
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[14px]">
            <Icon name="filter" size={14} className="text-muted-foreground" />
            筛选
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Select
            value={instanceId}
            onValueChange={(v) => changeFilter(() => setInstanceId(v))}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="全部实例" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部实例</SelectItem>
              {Object.values(instances).map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={tool} onValueChange={(v) => changeFilter(() => setTool(v))}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="全部工具" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部工具</SelectItem>
              {Array.from(new Set(Object.values(instances).map((i) => i.tool))).map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={level} onValueChange={(v) => changeFilter(() => setLevel(v))}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="全部级别" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部级别</SelectItem>
              {Object.keys(LEVEL_LABEL).map((l) => (
                <SelectItem key={l} value={l}>
                  {LEVEL_LABEL[l]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Switch checked={unreadOnly} onCheckedChange={(v) => changeFilter(() => setUnreadOnly(v))} />
            仅未读
          </label>

          {cursors.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => changeFilter(() => setCursors([]))}>
              回到第一页
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {query.isPending ? (
            <p className="p-5 text-[12.5px] text-muted-foreground">正在读取命中事件…</p>
          ) : events.length === 0 ? (
            <EmptyState
              icon="bell"
              title={cursors.length ? '这一页没有更多了' : '还没有命中记录'}
              desc={
                cursors.length
                  ? '往后已经翻到头了，回到第一页可以继续看'
                  : '实例跑起来并命中之后，记录会出现在这里'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[130px]">时间</TableHead>
                  <TableHead>命中</TableHead>
                  <TableHead className="w-[150px]">实例</TableHead>
                  <TableHead className="w-[100px]">命中方式</TableHead>
                  <TableHead className="w-[90px]">级别</TableHead>
                  <TableHead>通知</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e: HitEvent) => (
                  <TableRow key={e.id} className={e.read ? '' : 'bg-primary/[0.04]'}>
                    <TableCell className="text-[12px] text-muted-foreground">{e.ts}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {!e.read && <Badge variant="default">未读</Badge>}
                        <span className="text-[13px] font-medium">{e.title}</span>
                      </div>
                      {e.detail && (
                        <p className="mt-0.5 text-[12px] text-muted-foreground">{e.detail}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-[12.5px]">
                      {nameOf.get(e.instanceId) ?? e.instanceId}
                    </TableCell>
                    <TableCell className="text-[12.5px] text-muted-foreground">
                      {matchedByLabel(e.matchedBy)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={LEVEL_VARIANT[e.level] ?? 'secondary'}>
                        {LEVEL_LABEL[e.level] ?? e.level}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className={`text-[12.5px] ${
                        notifiedHasIssue(e.notified) ? 'text-warning' : 'text-muted-foreground'
                      }`}
                    >
                      {notifiedText(e.notified)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <Button size="sm" variant="outline" disabled={!cursors.length} onClick={goPrev}>
          <Icon name="chevronLeft" size={14} />
          上一页
        </Button>
        <span className="text-[12px] text-muted-foreground">
          第 {cursors.length + 1} 页 · 每页 {PAGE} 条
        </span>
        <Button size="sm" variant="outline" disabled={events.length < PAGE} onClick={goNext}>
          下一页
          <Icon name="chevronRight" size={14} />
        </Button>
      </div>
    </div>
  )
}
