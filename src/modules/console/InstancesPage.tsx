import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { TOOLS } from '@/app/moduleRegistry'
import { useInstanceStore } from '@/stores/instanceStore'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Icon } from '@/components/icon'
import { EmptyState } from '@/components/blocks/empty-state'
import { PageHeader } from '@/components/blocks/page-header'
import { InstanceTable } from '@/modules/console/InstanceTable'
import { useInstanceActions } from '@/modules/console/useInstanceActions'
import { useInstances } from '@/modules/console/useInstances'
import { fadeUp } from '@/lib/motion'

const ALL = 'all'

/** 实例管理：所有实例的唯一清单页，负责检索与批量新建 */
export default function InstancesPage() {
  const instances = useInstanceStore((s) => s.instances)
  const { create } = useInstanceActions()
  const [kw, setKw] = useState('')
  const [tool, setTool] = useState<string>(ALL)
  useInstances()

  const list = useMemo(
    () =>
      Object.values(instances)
        .filter((i) => (tool === ALL ? true : i.tool === tool))
        .filter((i) => {
          const t = kw.trim().toLowerCase()
          return !t || i.name.toLowerCase().includes(t) || i.id.toLowerCase().includes(t)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [instances, tool, kw],
  )

  const total = Object.keys(instances).length
  const filtered = kw.trim().length > 0 || tool !== ALL

  return (
    <div className="mx-auto max-w-[1240px] space-y-4 p-5">
      <PageHeader
        icon="instances"
        title="实例管理"
        desc="按工具或名称检索；每个实例独立窗口运行，互不影响"
        actions={
          <>
            <span className="text-[12px] text-muted-foreground">
              {filtered ? `${list.length} / ${total}` : `共 ${total}`} 个
            </span>
            {TOOLS.map((t) => (
              <Button
                key={t.id}
                variant="outline"
                size="sm"
                onClick={() => create.mutate({ tool: t.id })}
                disabled={create.isPending}
                title={t.desc}
              >
                <span className="size-2 flex-none rounded-full" style={{ background: t.color }} />
                <Icon name="plus" size={13} />
                {t.name}
              </Button>
            ))}
          </>
        }
      />

      <motion.div variants={fadeUp} initial="hidden" animate="show">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <div className="relative w-[240px]">
              <Icon
                name="search"
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input className="pl-8" placeholder="搜索实例名或 ID…" value={kw} onChange={(e) => setKw(e.target.value)} />
            </div>

            <Select value={tool} onValueChange={setTool}>
              <SelectTrigger className="w-[168px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部工具</SelectItem>
                {TOOLS.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    <span className="flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ background: t.color }} />
                      {t.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Badge variant="secondary">{list.length} 个结果</Badge>
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setKw('')
                  setTool(ALL)
                }}
              >
                <Icon name="close" size={13} />
                清除筛选
              </Button>
            )}
          </div>

          {list.length ? (
            <InstanceTable list={list} />
          ) : (
            <EmptyState
              icon={filtered ? 'search' : 'instances'}
              title={filtered ? '没有匹配的实例' : '还没有任何实例'}
              desc={
                filtered
                  ? '换个关键词，或把工具筛选切回「全部工具」。'
                  : '从右上角选一个工具新建，或回工具箱挑一个。'
              }
              actions={
                filtered ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setKw('')
                      setTool(ALL)
                    }}
                  >
                    清除筛选
                  </Button>
                ) : (
                  TOOLS.slice(0, 1).map((t) => (
                    <Button key={t.id} size="sm" onClick={() => create.mutate({ tool: t.id })} disabled={create.isPending}>
                      <Icon name="rocket" size={13} />
                      新建{t.name}
                    </Button>
                  ))
                )
              }
            />
          )}
        </Card>
      </motion.div>
    </div>
  )
}
