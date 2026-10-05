import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as echarts from 'echarts'
import { motion } from 'motion/react'
import { api, openLogStream } from '@/lib/api'
import { ipc } from '@/lib/ipc'
import { buildRunConfirm } from '@/lib/runGuard'
import { controlToastText } from '@/lib/runToast'
import { useInstanceStore } from '@/stores/instanceStore'
import { toast } from '@/stores/toastStore'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Kbd } from '@/components/ui/kbd'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Icon } from '@/components/icon'
import { EmptyState } from '@/components/blocks/empty-state'
import { ConfirmDialog } from '@/components/blocks/confirm-dialog'
import { StatCard } from '@/components/blocks/stat-card'
import CompareRun from '@/modules/instance/CompareRun'
import RunSummaryCard from '@/modules/instance/RunSummaryCard'
import { STATUS_TEXT } from '@/modules/console/instanceStatus'
import { useResolvedTheme } from '@/stores/themeStore'
import { chartPalette } from '@/lib/chartTheme'
import { formatAccel, hotkeyMapOf } from '@/lib/hotkey'
import { fadeUp, staggerList } from '@/lib/motion'
import type { HotkeyRouted } from '@/lib/ipc'

const ROW_STATUS: Record<string, { text: string; variant: 'success' | 'destructive' | 'secondary' | 'default' }> = {
  ok: { text: '成功', variant: 'success' },
  err: { text: '失败', variant: 'destructive' },
  skip: { text: '已跳过', variant: 'secondary' },
  wait: { text: '待执行', variant: 'default' },
}

/** 运行详情：配置页只做配置，运行与监控都在这里 */
export default function RunPage() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const inst = useInstanceStore((s) => s.instances[id])
  const transition = useInstanceStore((s) => s.transition)
  const ringRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLDivElement>(null)
  // ECharts 不吃 CSS 变量，主题变化时要用另一套具体色值重绘
  const theme = useResolvedTheme()
  const palette = useMemo(() => chartPalette(theme), [theme])
  /** 热键因冲突被路由到别的实例时的说明 */
  const [routed, setRouted] = useState<HotkeyRouted | null>(null)
  /** 执行前确认：点「开始执行」先弹框，确认后才真正下发 start */
  const [armStart, setArmStart] = useState(false)
  const runConfirm = inst ? buildRunConfirm(inst) : null

  const { data: rows = [] } = useQuery({
    queryKey: ['rows', id],
    queryFn: () => api.rows(id),
    refetchInterval: inst?.status === 'running' ? 1000 : false,
  })

  const { data: logs = [] } = useQuery({ queryKey: ['logs', id], queryFn: () => api.logs(id) })
  const [streamLines, pushLine] = useLogBuffer()

  // 桌面监控：命中事件单独成列表（只在 monitor 工具下启用）
  const isMonitor = inst?.config.tool === 'monitor'
  const { data: hits = [] } = useQuery({
    queryKey: ['monitorHits', id],
    queryFn: () => api.monitorHits(id),
    enabled: isMonitor,
    refetchInterval: inst?.status === 'running' ? 1000 : false,
  })
  const ruleCount = inst && inst.config.tool === 'monitor' ? inst.config.rules.length : 0

  useEffect(() => {
    return openLogStream(id, pushLine)
  }, [id, pushLine])

  const controlMut = useMutation({
    mutationFn: (action: 'start' | 'pause' | 'resume' | 'stop') => api.control(id, action),
    onSuccess: (res, action) => {
      // 状态迁移由后端确认，前端状态机做守卫
      transition(id, res.status as never)
      qc.invalidateQueries({ queryKey: ['instances'] })
      toast.success(controlToastText(action))
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const status = inst?.status

  // 状态一变就重取明细与日志。
  //
  // `refetchInterval` 只在「运行中」生效，所以最后那一次状态跃迁（比如第 3 条指令
  // 失败、整轮转成 error）不会自动把收尾的结果取回来 —— 页面会停在倒数第二次的快照上。
  useEffect(() => {
    qc.invalidateQueries({ queryKey: ['rows', id] })
    qc.invalidateQueries({ queryKey: ['logs', id] })
  }, [status, id, qc])

  // 全局热键：由主进程按「焦点窗口 > 最近用过 > 第一个」路由到具体实例，
  // 所以这里收到的一定是发给**本实例**的事件，不会连累别的实例。
  //
  // 三个动作要显式分派 —— 写成 `if (toggle) … else stop` 的话，
  // 新增的 run 会被静默当成 stop（加枚举值时最容易漏的一处）。
  useEffect(() => {
    return ipc.onHotkey((action) => {
      if (action === 'run') {
        if (status === 'idle' || status === 'completed' || status === 'error') controlMut.mutate('start')
        else if (status === 'paused') controlMut.mutate('resume')
        return
      }
      if (action === 'toggle') controlMut.mutate(status === 'running' ? 'pause' : 'resume')
      else controlMut.mutate('stop')
    })
  }, [status])

  // 同名热键被多个实例占用时，主进程会回执「这次打给了谁」
  useEffect(() => {
    let timer: number | undefined
    const off = ipc.onHotkeyRouted((info) => {
      setRouted(info)
      // 连续路由/卸载时先清掉上一个定时器：否则旧定时器会把新提示提前清空，
      // 或对已卸载组件 setState
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => setRouted(null), 6000)
    })
    return () => {
      off()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  const stats = useMemo(() => {
    const c = (k: string) => rows.filter((r) => r.status === k).length
    return { ok: c('ok'), err: c('err'), skip: c('skip'), wait: c('wait') }
  }, [rows])

  useEffect(() => {
    if (!ringRef.current || !lineRef.current) return
    const ring = echarts.init(ringRef.current)
    ring.setOption({
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 12, color: palette.subText } },
      series: [
        {
          type: 'pie',
          radius: ['50%', '72%'],
          center: ['50%', '43%'],
          // 扇区之间用画布底色描边：深色下若写死白色会露出白缝
          itemStyle: { borderColor: palette.surface, borderWidth: 2 },
          label: {
            show: true,
            position: 'center',
            formatter: (p: { value: number; name: string }) => `${p.value}\n${p.name}`,
            fontSize: 13,
            lineHeight: 20,
            color: palette.text,
          },
          data: [
            { value: stats.ok, name: '成功', itemStyle: { color: palette.ok } },
            { value: stats.err, name: '失败', itemStyle: { color: palette.err } },
            { value: stats.skip, name: '跳过', itemStyle: { color: palette.skip } },
            { value: stats.wait, name: '待执行', itemStyle: { color: palette.wait } },
          ],
        },
      ],
    })
    const line = echarts.init(lineRef.current)
    const durations = rows.filter((r) => r.durationMs).map((r) => +(r.durationMs / 1000).toFixed(1))
    line.setOption({
      grid: { left: 34, right: 14, top: 14, bottom: 24 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: durations.map((_, i) => `r${i + 1}`),
        axisLine: { lineStyle: { color: palette.axis } },
        axisLabel: { fontSize: 11, color: palette.subText },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: palette.split } },
        axisLabel: { fontSize: 11, color: palette.subText },
      },
      series: [
        {
          type: 'line',
          smooth: true,
          data: durations.length ? durations : [0],
          itemStyle: { color: palette.brand },
          areaStyle: { color: palette.areaFill },
        },
      ],
    })
    return () => {
      ring.dispose()
      line.dispose()
    }
  }, [stats, rows, palette])

  if (!inst) {
    return (
      <EmptyState
        className="h-full"
        icon="error"
        title="实例不存在或已被删除"
        desc="它可能已经在这个窗口之外被删掉了，回到控制台的实例管理里确认一下。"
      />
    )
  }

  // Excel 对比是一次性任务，没有逐行进度与热键，用专门的运行视图
  if (inst.config.tool === 'cmp') return <CompareRun id={id} />

  const running = inst.status === 'running'
  const hk = hotkeyMapOf(inst.config)
  // 按键精灵：一次性动作，没有「N/M 行」这种进度语义，台账粒度是「一条指令一行」
  const isMacro = inst.config.tool === 'macro'

  return (
    <div className="space-y-4 p-5">
      <motion.div variants={fadeUp} initial="hidden" animate="show" className="flex flex-wrap items-center gap-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon name="activity" size={17} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-medium leading-tight">{inst.name}</h1>
            <Badge variant={running ? 'success' : inst.status === 'error' ? 'destructive' : 'secondary'}>
              {running && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
              {STATUS_TEXT[inst.status]}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {isMacro ? '执行一次即按顺序走完整串动作，配置请前往「实例配置」' : '运行与监控在此进行，配置请前往「实例配置」'}
          </p>
        </div>
        <div className="flex-1" />
        <span className="hidden items-center gap-1.5 text-xs text-muted-foreground lg:flex">
          <Kbd>{formatAccel(hk.run)}</Kbd> {isMacro ? '执行一次' : '开始执行'}
          <Kbd>{formatAccel(hk.toggle)}</Kbd> 暂停 / 继续
          <Kbd>{formatAccel(hk.stop)}</Kbd> 停止
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => ipc.openInstance({ id, tool: inst.tool, name: inst.name, route: `/instance/${id}/config` })}
        >
          <Icon name="sliders" size={13} />
          配置
        </Button>
        <Button
          size="sm"
          onClick={() => {
            // 运行中 → 暂停；已暂停 → 继续；其余 → 先过执行前确认这道护栏
            if (running) {
              controlMut.mutate('pause')
              return
            }
            if (status === 'paused') {
              controlMut.mutate('resume')
              return
            }
            if (runConfirm) setArmStart(true)
            else controlMut.mutate('start')
          }}
          disabled={controlMut.isPending}
        >
          <Icon name={running ? 'pause' : 'play'} size={13} />
          {running ? '暂停' : status === 'paused' ? '继续' : isMacro ? '执行一次' : '开始执行'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => controlMut.mutate('stop')} disabled={controlMut.isPending}>
          <Icon name="stop" size={13} />
          停止
        </Button>
      </motion.div>

      {runConfirm && (
        <ConfirmDialog
          open={armStart}
          onOpenChange={setArmStart}
          icon="play"
          action="start"
          title={runConfirm.title}
          desc={runConfirm.desc}
          confirmText={runConfirm.confirmText}
          onConfirm={() => {
            setArmStart(false)
            controlMut.mutate('start')
          }}
        />
      )}

      {routed && (
        <Alert variant="warning">
          <Icon name="warning" size={16} />
          <AlertDescription>
            <Kbd>{formatAccel(routed.accel)}</Kbd> 同时绑在多个实例上，这次作用于「{routed.chosen}」
            {routed.others.length > 0 && `；${routed.others.join('、')} 没有受影响`}。想去掉这个提示，就在各自的配置里改成不同的键。
          </AlertDescription>
        </Alert>
      )}

      <motion.div variants={staggerList} initial="hidden" animate="show" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {isMonitor
          ? [
              <StatCard key="hits" label="命中次数" value={hits.length} tone="ok" icon="bellRing" />,
              <StatCard key="rules" label="监控目标" value={ruleCount} tone="brand" icon="assets" />,
            ]
          : [
              <StatCard key="ok" label="成功" value={stats.ok} tone="ok" icon="success" />,
              <StatCard key="err" label="失败" value={stats.err} tone={stats.err ? 'err' : 'default'} icon="error" />,
              <StatCard key="skip" label="跳过" value={stats.skip} icon="chevronRight" />,
              <StatCard key="wait" label="待执行" value={stats.wait} tone="brand" icon="clock" />,
            ]}
      </motion.div>

      {!isMonitor && <RunSummaryCard id={id} name={inst?.name ?? ''} running={inst?.status === 'running'} />}

      {!isMonitor && (
        <>
          <Card>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">整体进度</span>
                <span className="font-mono tabular-nums">
                  {inst.done} / {inst.total}
                  {isMacro && ' 条指令'}
                </span>
              </div>
              <Progress value={inst.total ? Math.round((inst.done / inst.total) * 100) : 0} />
            </CardContent>
          </Card>

          {!isMacro && (
          <div className="grid grid-cols-12 gap-4">
            <motion.div variants={fadeUp} initial="hidden" animate="show" className="col-span-12 lg:col-span-6">
              <Card>
                <CardHeader>
                  <CardTitle>结果分布</CardTitle>
                </CardHeader>
                <div ref={ringRef} style={{ height: 240 }} />
              </Card>
            </motion.div>
            <motion.div variants={fadeUp} initial="hidden" animate="show" className="col-span-12 lg:col-span-6">
              <Card>
                <CardHeader>
                  <CardTitle>每行耗时（秒）</CardTitle>
                </CardHeader>
                <div ref={lineRef} style={{ height: 240 }} />
              </Card>
            </motion.div>
          </div>
          )}

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>{isMacro ? '逐条明细' : '执行明细'}</CardTitle>
              <span className="text-sm text-muted-foreground">
                {isMacro ? '每一步都会留痕，失败会指出是第几步' : '结果实时回写 Excel 状态列'}
              </span>
            </CardHeader>
            {rows.length ? (
              <Table className="min-w-[720px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[64px]">{isMacro ? '步' : '行'}</TableHead>
                    <TableHead>{isMacro ? '指令' : '关键字'}</TableHead>
                    <TableHead className="w-[110px]">状态</TableHead>
                    <TableHead>说明</TableHead>
                    <TableHead className="w-[90px] text-right">耗时</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const s = ROW_STATUS[r.status] ?? ROW_STATUS.wait
                    return (
                      <TableRow key={r.rowNo}>
                        <TableCell className="font-mono text-sm tabular-nums">{r.rowNo}</TableCell>
                        <TableCell className="font-medium">{r.keyValue}</TableCell>
                        <TableCell>
                          <Badge variant={s.variant}>{s.text}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.message || '—'}</TableCell>
                        <TableCell className="text-right font-mono text-sm tabular-nums">
                          {(r.durationMs / 1000).toFixed(1)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                icon="table"
                title="暂无执行明细"
                desc={
                  isMacro
                    ? '点右上角「执行一次」后，每条指令的结果会按顺序出现在这里。'
                    : '点右上角「开始执行」后，每行的结果会实时出现在这里，同时回写 Excel 的状态列。'
                }
              />
            )}
          </Card>
        </>
      )}

      {isMonitor && (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>命中记录</CardTitle>
            <span className="text-sm text-muted-foreground">目标图出现时记一次，持续存在不重复</span>
          </CardHeader>
          {hits.length ? (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[200px]">时间</TableHead>
                  <TableHead>目标素材</TableHead>
                  <TableHead className="w-[110px]">相似度</TableHead>
                  <TableHead className="w-[150px]">屏幕位置</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hits.map((h, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-sm">{h.ts}</TableCell>
                    <TableCell className="font-mono text-sm">{h.assetId}</TableCell>
                    <TableCell>
                      <Badge variant={(h.similarity ?? 0) >= 0.85 ? 'success' : 'warning'}>
                        {((h.similarity ?? 0) * 100).toFixed(0)}%
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {h.rect ? `${h.rect[0]}, ${h.rect[1]}` : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon="monitor"
              title="暂无命中"
              desc="目标图出现在监测区域时会记录在这里。如果一直没命中，可以先把相似度阈值调低一点试试。"
            />
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>运行日志</CardTitle>
          <span className="text-sm text-muted-foreground">仅保留本实例日志</span>
        </CardHeader>
        <div className="logbox h-44 overflow-y-auto p-3.5 font-mono text-sm">
          {logs.map((l, i) => (
            <div key={i}>
              [{l.ts}] {l.message}
            </div>
          ))}
          {streamLines.map((l, i) => (
            <div key={`s${i}`}>{l}</div>
          ))}
          {!logs.length && !streamLines.length && (
            <div className="text-muted-foreground opacity-70">还没有日志输出。实例开始执行后，引擎会把每一步写在里。</div>
          )}
        </div>
      </Card>
    </div>
  )
}

/** 日志流本地缓冲：保留最近 200 行，避免无限增长 */
function useLogBuffer() {
  const [lines, setLines] = useState<string[]>([])
  const push = useCallback((line: string) => {
    setLines((prev) => {
      const next = [...prev, line]
      return next.length > 200 ? next.slice(-200) : next
    })
  }, [])
  return [lines, push] as const
}
