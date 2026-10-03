import { useMemo } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { isToolId, toolById } from '@/app/moduleRegistry'
import { api } from '@/lib/api'
import { useInstanceStore } from '@/stores/instanceStore'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Icon } from '@/components/icon'
import { EmptyState } from '@/components/blocks/empty-state'
import { PageHeader } from '@/components/blocks/page-header'
import { InstanceTable } from '@/modules/console/InstanceTable'
import { useInstanceActions } from '@/modules/console/useInstanceActions'
import { useInstances } from '@/modules/console/useInstances'
import { fadeUp } from '@/lib/motion'

/**
 * 工具落地页：左侧导航里点某个工具后到的地方。
 * 职责是「先讲清楚这个工具怎么用，再给出该工具的实例」——
 * 而不是把用户直接丢进配置页。
 */
export default function ToolLandingPage() {
  const { toolId = '' } = useParams()
  const instances = useInstanceStore((s) => s.instances)
  const { create } = useInstanceActions()
  useInstances()

  // 该工具存过的方案：没有它们，「从方案创建」就无从选起
  const { data: plans = [] } = useQuery({
    queryKey: ['plans', toolId],
    queryFn: () => api.listPlans(toolId),
    enabled: isToolId(toolId),
  })

  const list = useMemo(
    () => Object.values(instances).filter((i) => i.tool === toolId).sort((a, b) => b.updatedAt - a.updatedAt),
    [instances, toolId],
  )

  if (!isToolId(toolId)) return <Navigate to="/" replace />
  const tool = toolById(toolId)

  return (
    <div className="mx-auto max-w-[1240px] space-y-4 p-5">
      <PageHeader
        icon={tool.icon}
        title={
          <span className="flex items-center gap-2">
            {tool.name}
            {tool.multiOpen && <Badge variant="secondary">可多开</Badge>}
          </span>
        }
        desc={tool.desc}
        actions={
          <Button size="sm" onClick={() => create.mutate({ tool: tool.id })} disabled={create.isPending}>
            <Icon name="rocket" size={14} />
            新建实例
          </Button>
        }
      />

      <div className="grid grid-cols-12 gap-4">
        <motion.div variants={fadeUp} initial="hidden" animate="show" className="col-span-12 lg:col-span-9">
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>该工具的实例</CardTitle>
              <span className="text-[12px] text-muted-foreground">{list.length} 个</span>
            </CardHeader>
            {list.length ? (
              <InstanceTable list={list} showTool={false} />
            ) : (
              <EmptyState
                icon={tool.icon}
                title="该工具下还没有实例"
                desc="每个实例有独立的目标窗口、Excel 与流程配置，可以并行跑互不干扰。"
                actions={
                  <Button size="sm" onClick={() => create.mutate({ tool: tool.id })} disabled={create.isPending}>
                    <Icon name="plus" size={13} />
                    新建实例
                  </Button>
                }
              />
            )}
          </Card>
        </motion.div>

        <motion.div variants={fadeUp} initial="hidden" animate="show" className="col-span-12 lg:col-span-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Icon name="sparkles" size={14} className="text-muted-foreground" />
                使用要点
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {tool.hints.map((h, i) => (
                <div key={i} className="flex gap-3 text-[12.5px] leading-relaxed">
                  <span className="mt-px flex size-[18px] flex-none items-center justify-center rounded-full bg-muted font-mono text-[10.5px] text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="text-foreground/90">{h}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Icon name="fileText" size={14} className="text-muted-foreground" />
                从方案新建
              </CardTitle>
              <span className="text-[12px] text-muted-foreground">套一份现成配置，省掉重配</span>
            </CardHeader>
            <CardContent className="space-y-2">
              {plans.length ? (
                plans.map((p) => (
                  <Button
                    key={p.id}
                    variant="outline"
                    size="sm"
                    className="w-full justify-start"
                    disabled={create.isPending}
                    onClick={() => create.mutate({ tool: tool.id, planId: p.id, name: p.name })}
                  >
                    <Icon name="fileText" size={13} />
                    {p.name}
                  </Button>
                ))
              ) : (
                <p className="text-[12.5px] text-muted-foreground">
                  还没有方案。先建一个实例、配好它，再到配置页「另存为方案」。
                </p>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  )
}
