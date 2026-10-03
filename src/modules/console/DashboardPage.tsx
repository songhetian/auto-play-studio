import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { api } from '@/lib/api'
import { NAV_GROUPS, toolSections } from '@/app/navModel'
import { useInstanceStore } from '@/stores/instanceStore'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Icon } from '@/components/icon'
import { EmptyState } from '@/components/blocks/empty-state'
import { PageHeader } from '@/components/blocks/page-header'
import { StatCard } from '@/components/blocks/stat-card'
import { ToolCard, ToolSectionHeader, UtilityCard } from '@/components/blocks/tool-card'
import { InstanceTable } from '@/modules/console/InstanceTable'
import { isLive } from '@/modules/console/instanceStatus'
import { useInstanceActions } from '@/modules/console/useInstanceActions'
import { useInstances } from '@/modules/console/useInstances'
import { fadeUp, staggerList } from '@/lib/motion'

/**
 * 工具箱首页。
 *
 * 先给「有哪些工具、点一下就开工」，再给「现在有没有事需要我管」，
 * 所以顺序是：工具格子 → 资源入口 → 指标 → 异常提醒 → 活跃实例。
 */
export default function DashboardPage() {
  const qc = useQueryClient()
  const instances = useInstanceStore((s) => s.instances)
  const { create } = useInstanceActions()
  useInstances()

  // 引擎启动时已自动对账，这里读那次结果用于展示「恢复了什么」
  const recovery = useQuery({ queryKey: ['recovery'], queryFn: api.recoverySummary })
  const syncMut = useMutation({
    mutationFn: () => api.recoverInstances(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['instances'] })
      qc.invalidateQueries({ queryKey: ['recovery'] })
    },
  })

  const all = useMemo(() => Object.values(instances), [instances])
  const live = useMemo(
    () => all.filter((i) => isLive(i.status)).sort((a, b) => b.updatedAt - a.updatedAt),
    [all],
  )
  const broken = useMemo(() => all.filter((i) => i.status === 'error'), [all])
  const paused = all.filter((i) => i.status === 'paused').length

  const countByTool = useMemo(() => {
    const m: Record<string, number> = {}
    for (const i of all) m[i.tool] = (m[i.tool] ?? 0) + 1
    return m
  }, [all])

  // 首页的「资源与系统」入口从导航信息架构里派生 —— navModel 是唯一真源。
  // 这里曾经是写死的（素材库 + 设置），加「知识库」时导航有了、首页没有，
  // 用户从首页就找不到入口。
  const utilityItems = useMemo(
    () => NAV_GROUPS.filter((g) => g.id === 'resource' || g.id === 'system').flatMap((g) => g.items),
    [],
  )

  // 工具分段与导航分组同源 —— 先按「谁触发、产出什么」分好组，再原样铺出来。
  // 这里曾经是 `TOOLS.filter(t => t.id === 'rpa' || t.id === 'monitor')`：
  // 分组改在导航里、分段硬编码在页面里，改一边另一边不会动。
  const sections = useMemo(() => toolSections(), [])

  return (
    <div className="mx-auto max-w-[1240px] space-y-5 p-5">
      <PageHeader
        icon="boxes"
        title="工具箱"
        desc="每个工具都能同时开多个实例，实例之间完全独立、并行运行"
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to="/instances">
                <Icon name="instances" size={14} />
                实例管理
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => syncMut.mutate()} disabled={syncMut.isPending}>
              <Icon name="refresh" size={14} className={syncMut.isPending ? 'animate-spin' : undefined} />
              重新同步状态
            </Button>
          </>
        }
      />

      {recovery.data && recovery.data.recovered > 0 && (
        <motion.div variants={fadeUp} initial="hidden" animate="show">
          <Alert variant="warning">
            <Icon name="warning" size={16} />
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span>
                引擎重启时已恢复 <b className="font-medium">{recovery.data.recovered}</b> 个被中断的实例，已完成进度已保留，可重新点「开始」续跑。
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => qc.invalidateQueries({ queryKey: ['instances'] })}
              >
                <Icon name="refresh" size={13} />
                刷新列表
              </Button>
            </AlertDescription>
          </Alert>
        </motion.div>
      )}

      {/* ── 工具箱：分段与导航分组同源 ─────────────────────── */}
      {sections.map((s) => (
        <motion.section key={s.id} variants={staggerList} initial="hidden" animate="show" className="space-y-3">
          <ToolSectionHeader title={s.label} hint={s.hint} />
          <div className="grid gap-3 sm:grid-cols-2">
            {s.tools.map((t) => (
              <ToolCard
                key={t.id}
                to={`/tools/${t.id}`}
                name={t.name}
                desc={t.desc}
                color={t.color}
                icon={t.icon}
                count={countByTool[t.id] ?? 0}
                badge={t.multiOpen ? <Badge variant="secondary">可多开</Badge> : undefined}
                pending={create.isPending}
                onPrimary={() => create.mutate(t.id)}
              />
            ))}
          </div>
        </motion.section>
      ))}

      <motion.section variants={staggerList} initial="hidden" animate="show" className="space-y-3">
        <ToolSectionHeader title="资源与系统" hint="工具共用" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {utilityItems.map((it) => (
            <UtilityCard key={it.id} to={it.path} name={it.label} desc={it.desc} icon={it.icon} />
          ))}
        </div>
      </motion.section>

      {/* ── 运行概况 ───────────────────────────────────────── */}
      <motion.section
        variants={staggerList}
        initial="hidden"
        animate="show"
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
      >
        <StatCard label="实例总数" value={all.length} icon="instances" />
        <StatCard label="运行中" value={live.length} tone="ok" icon="activity" hint="含布防、暂停、启停中" />
        <StatCard label="已暂停" value={paused} tone={paused ? 'warn' : 'default'} icon="pause" />
        <StatCard label="异常" value={broken.length} tone={broken.length ? 'err' : 'default'} icon="warning" />
      </motion.section>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-8">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Icon name="play" size={14} className="text-muted-foreground" />
                活跃实例
              </CardTitle>
              <span className="text-[12px] text-muted-foreground">{live.length} 个</span>
            </CardHeader>
            {live.length ? (
              <InstanceTable list={live} />
            ) : (
              <EmptyState
                icon="play"
                title="当前没有正在运行的实例"
                desc={
                  all.length
                    ? '已配置好的实例可以从「实例管理」里挑一个开始执行。'
                    : '从上面的工具箱里选一个工具，点「新建」即可开一个实例。'
                }
                actions={
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/instances">
                      去实例管理
                      <Icon name="arrowRight" size={13} />
                    </Link>
                  </Button>
                }
              />
            )}
          </Card>
        </div>

        <div className="col-span-12 space-y-4 lg:col-span-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Icon name="warning" size={14} className={broken.length ? 'text-destructive' : 'text-muted-foreground'} />
                需要处理
              </CardTitle>
              <span className="text-[12px] text-muted-foreground">{broken.length} 个</span>
            </CardHeader>
            {broken.length ? (
              <CardContent className="space-y-2 p-0 py-3">
                {broken.slice(0, 5).map((i) => (
                  <div key={i.id} className="flex items-center gap-2 px-5 text-[13px]">
                    <span className="size-1.5 flex-none rounded-full bg-destructive" />
                    <span className="truncate">{i.name}</span>
                    <span className="ml-auto flex-none font-mono text-[11.5px] text-muted-foreground">{i.id}</span>
                  </div>
                ))}
                {broken.length > 5 && (
                  <div className="px-5 text-[11.5px] text-muted-foreground">…等 {broken.length} 个</div>
                )}
              </CardContent>
            ) : (
              <CardContent className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <Icon name="success" size={15} className="text-[hsl(var(--ok))]" />
                没有异常实例，一切正常。
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Icon name="sparkles" size={14} className="text-muted-foreground" />
                开始之前
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 p-0 py-3.5">
              {[
                { icon: 'sheet' as const, text: '数据类工具先准备一份 Excel，系统会自动识别列名' },
                { icon: 'assets' as const, text: '提醒类工具（桌面图片监控）先往素材库放一张目标图' },
                { icon: 'keyboard' as const, text: '每个实例的快捷键可以在实例配置里单独改' },
              ].map((r) => (
                <div key={r.text} className="flex gap-2.5 px-5 text-[12.5px] leading-relaxed text-muted-foreground">
                  <Icon name={r.icon} size={14} className="mt-0.5 flex-none" />
                  <span>{r.text}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
