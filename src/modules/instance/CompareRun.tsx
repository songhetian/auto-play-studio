import { useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as echarts from 'echarts'
import { motion } from 'motion/react'
import { api, type CompareStatus } from '@/lib/api'
import { ipc } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { useInstanceStore } from '@/stores/instanceStore'
import { useResolvedTheme } from '@/stores/themeStore'
import { chartPalette } from '@/lib/chartTheme'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Icon, type IconName } from '@/components/icon'
import { EmptyState } from '@/components/blocks/empty-state'
import { StatCard } from '@/components/blocks/stat-card'
import { fadeUp, staggerList } from '@/lib/motion'
import type { ResolvedTheme } from '@/lib/theme'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline'

/**
 * 结论 -> 展示口径（与后端 STATUS_CN 一致，颜色沿用国产习惯：红色为「不一致」需关注）。
 * 单元格底色一律走语义令牌，深浅主题各自整套翻转，不再写死色值或深色专用变体。
 */
const STATUS_META: Record<CompareStatus, { text: string; badge: BadgeVariant; cell: string }> = {
  ok: { text: '一致', badge: 'success', cell: '' },
  diff: { text: '不一致', badge: 'destructive', cell: 'bg-destructive/10 text-destructive' },
  missing: { text: '缺失', badge: 'default', cell: 'bg-primary/10 text-primary' },
  extra: { text: '多余', badge: 'secondary', cell: 'bg-muted text-muted-foreground' },
  error: { text: '数据错误', badge: 'warning', cell: 'bg-[hsl(var(--warn)/0.12)] text-[hsl(var(--warn))]' },
  unknown: { text: '—', badge: 'outline', cell: '' },
}

const KPI: Array<{ label: string; key: CompareStatus; tone: 'ok' | 'err' | 'warn' | 'brand' | 'default'; icon: IconName }> = [
  { label: '一致', key: 'ok', tone: 'ok', icon: 'success' },
  { label: '不一致', key: 'diff', tone: 'err', icon: 'error' },
  { label: '缺失', key: 'missing', tone: 'brand', icon: 'search' },
  { label: '多余', key: 'extra', tone: 'default', icon: 'plus' },
  { label: '数据错误', key: 'error', tone: 'warn', icon: 'warning' },
]

/** 把当前主题下的语义令牌转成 ECharts 能吃的具体色值（ECharts 不认 CSS 变量） */
function tokenColor(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return raw ? `hsl(${raw.split(/\s+/).join(', ')})` : fallback
}

/** 图表色值：能落到 chartPalette 的走调色板，其余取语义令牌，避免在页面里写死 hex */
function statusColor(theme: ResolvedTheme, status: CompareStatus): string {
  const p = chartPalette(theme)
  switch (status) {
    case 'ok':
      return p.ok
    case 'diff':
      return p.err
    case 'missing':
      return p.brand
    case 'extra':
      return p.wait
    case 'error':
      return tokenColor('--warn', p.skip)
    default:
      return p.subText
  }
}

/** 差异单元格的底色类；一致/未知不着色，避免整表花掉 */
function cellClass(status?: CompareStatus): string {
  if (!status || status === 'ok' || status === 'unknown') return ''
  return STATUS_META[status].cell
}

export default function CompareRun({ id }: { id: string }) {
  const qc = useQueryClient()
  const inst = useInstanceStore((s) => s.instances[id])
  const pieRef = useRef<HTMLDivElement>(null)
  const theme = useResolvedTheme()
  const palette = useMemo(() => chartPalette(theme), [theme])

  const { data: report } = useQuery({
    queryKey: ['compare-result', id],
    queryFn: () => api.compareResult(id),
    retry: false,
  })
  const { data: reportPath } = useQuery({
    queryKey: ['compare-report-path', id],
    queryFn: () => api.compareReportPath(id),
    retry: false,
  })

  const runMut = useMutation({
    mutationFn: () => api.runCompare(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['compare-result', id] })
      qc.invalidateQueries({ queryKey: ['compare-report-path', id] })
      qc.invalidateQueries({ queryKey: ['rows', id] })
      qc.invalidateQueries({ queryKey: ['logs', id] })
      qc.invalidateQueries({ queryKey: ['instances'] })
    },
  })

  const summary = report?.summary ?? {}
  const pieData = useMemo(
    () => KPI.map((k) => ({ name: k.label, value: summary[k.key] ?? 0, itemStyle: { color: statusColor(theme, k.key) } })),
    [summary, theme],
  )

  useEffect(() => {
    if (!pieRef.current || !report) return
    const chart = echarts.init(pieRef.current)
    chart.setOption({
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 12, color: palette.subText } },
      series: [
        {
          type: 'pie',
          radius: ['52%', '74%'],
          center: ['50%', '44%'],
          itemStyle: { borderColor: palette.surface, borderWidth: 2 },
          label: { show: false },
          data: pieData,
        },
      ],
    })
    return () => chart.dispose()
  }, [report, pieData, palette])

  if (!inst) {
    return (
      <div className="p-5">
        <EmptyState
          className="h-full"
          icon="error"
          title="实例不存在或已被删除"
          desc="它可能已经在这个窗口之外被删掉了，回控制台的实例管理里确认一下。"
        />
      </div>
    )
  }

  const pending = runMut.isPending

  return (
    <div className="space-y-4 p-5">
      <motion.div variants={fadeUp} initial="hidden" animate="show" className="flex flex-wrap items-center gap-3">
        <h1 className="text-[16px] font-medium leading-tight">{inst.name}</h1>
        <Badge variant={report ? 'success' : 'secondary'}>{report ? '已有结果' : '未执行'}</Badge>
        <span className="text-[12px] text-muted-foreground">以 A 表为基准逐行核对，结果写入报告文件</span>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => ipc.openInstance({ id, tool: inst.tool, name: inst.name, route: `/instance/${id}/config` })}
        >
          <Icon name="sliders" size={13} />
          配置
        </Button>
        {reportPath?.path && (
          <Button variant="outline" size="sm" onClick={() => ipc.showItem(reportPath.path)}>
            <Icon name="externalLink" size={13} />
            打开报告文件
          </Button>
        )}
        <Button size="sm" onClick={() => runMut.mutate()} disabled={pending}>
          <Icon name={pending ? 'refresh' : 'play'} size={13} className={pending ? 'animate-spin' : undefined} />
          {pending ? '对比中…' : '开始对比'}
        </Button>
      </motion.div>

      {runMut.isError && (
        <Alert variant="destructive">
          <Icon name="error" size={16} />
          <AlertDescription>{(runMut.error as Error).message}</AlertDescription>
        </Alert>
      )}
      {report?.warnings?.length ? (
        <Alert variant="warning">
          <Icon name="warning" size={16} />
          <AlertDescription className="space-y-1">
            {report.warnings.map((w, i) => (
              <div key={i}>· {w}</div>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      {!report ? (
        <Card>
          <EmptyState
            icon="cmp"
            title="还没有对比结果"
            desc="点右上角「开始对比」跑一次，完成后这里会给出各列结论、结论分布和逐行明细。"
            actions={
              <Button size="sm" onClick={() => runMut.mutate()} disabled={pending}>
                <Icon name={pending ? 'refresh' : 'play'} size={13} className={pending ? 'animate-spin' : undefined} />
                {pending ? '对比中…' : '开始对比'}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <motion.div variants={staggerList} initial="hidden" animate="show" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {KPI.map((k) => (
              <StatCard key={k.key} label={k.label} value={summary[k.key] ?? 0} tone={k.tone} icon={k.icon} />
            ))}
          </motion.div>

          <div className="grid grid-cols-12 gap-4">
            <motion.div variants={fadeUp} initial="hidden" animate="show" className="col-span-12 lg:col-span-4">
              <Card>
                <CardHeader>
                  <CardTitle>结论分布</CardTitle>
                  <span className="text-[12px] text-muted-foreground">合计 {summary.total ?? 0} 行</span>
                </CardHeader>
                <div ref={pieRef} style={{ height: 260 }} />
              </Card>
            </motion.div>
            <motion.div variants={fadeUp} initial="hidden" animate="show" className="col-span-12 lg:col-span-8">
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>结果明细</CardTitle>
                  <span className="text-[12px] text-muted-foreground">带底色的是差异单元格</span>
                </CardHeader>
                <div className="max-h-[520px] overflow-auto">
                  <Table style={{ minWidth: Math.max(760, (report.header.length + 1) * 130) }}>
                    <TableHeader className="sticky top-0 z-10 bg-card">
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-[92px]">结论</TableHead>
                        {report.header.map((h) => (
                          <TableHead key={h} className="whitespace-nowrap">
                            {h}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.rows.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>
                            <Badge variant={STATUS_META[r.status]?.badge ?? 'outline'}>
                              {STATUS_META[r.status]?.text ?? '—'}
                            </Badge>
                          </TableCell>
                          {report.header.map((h, ci) => (
                            <TableCell
                              key={h}
                              className={cn('whitespace-nowrap', cellClass(ci === 0 ? r.status : r.cell_status[h]))}
                            >
                              {r.cells[h] || ''}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Card>
            </motion.div>
          </div>
        </>
      )}
    </div>
  )
}
