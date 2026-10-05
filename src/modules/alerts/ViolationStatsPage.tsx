import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
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
import { downloadTextFile } from '@/lib/download'
import {
  buildViolationCsv,
  violationFileName,
  type ViolationEvent,
  type ViolationLevel,
} from '@/lib/violationStats'

const ALL = 'all'
const PAGE = 50

const LEVEL_LABEL: Record<string, string> = { high: '高危', mid: '中危', low: '低危' }
const LEVEL_VARIANT: Record<string, 'destructive' | 'warning' | 'secondary'> = {
  high: 'destructive',
  mid: 'warning',
  low: 'secondary',
}

/**
 * 违规统计（工单 04 · ⑤）：敏感词违规事件的只读复盘页。
 *
 * 数据来自 guard 命中时落库的 `violation_events`（④）。这一页只回答主管的两类问题：
 * 「这段时间哪条词违规最多、多严重」「某条具体违规发生在什么时候、谁（本机用户）」。
 * 纯单机 A 线下坐席恒为一人，所以坐席只作展示列、不做过滤控件（B 阶段直接能加）。
 */
export default function ViolationStatsPage() {
  const [word, setWord] = useState('')
  const [level, setLevel] = useState(ALL)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const filters = {
    word: word.trim() || undefined,
    level: level === ALL ? undefined : level,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    limit: PAGE,
  }
  const filterKey = JSON.stringify(filters)

  const list = useQuery({
    queryKey: ['violations', filterKey],
    queryFn: () => api.violations(filters),
  })
  const summary = useQuery({
    queryKey: ['violation-summary', filterKey],
    queryFn: () => api.violationSummary(filters),
  })

  const rows = list.data ?? []
  const total = summary.data?.total ?? 0
  const byLevel = summary.data?.byLevel ?? {}

  const resetFilters = () => {
    setWord('')
    setLevel(ALL)
    setDateFrom('')
    setDateTo('')
  }

  const onExport = async () => {
    // 导出不受分页限制：拉全量（limit 给大值），前端拼 CSV
    const all = await api.violations({ ...filters, limit: 100000 })
    downloadTextFile(violationFileName(), buildViolationCsv(all))
  }

  const levelBadge = (lv: ViolationLevel) => (
    <Badge variant={LEVEL_VARIANT[lv] ?? 'secondary'}>{LEVEL_LABEL[lv] ?? lv}</Badge>
  )

  const topWords = useMemo(() => summary.data?.byWord ?? [], [summary.data])

  return (
    <div className="mx-auto max-w-[1240px] space-y-5 p-5">
      <PageHeader
        icon="shield"
        title="违规统计"
        desc="敏感词违规事件的按词 / 危级 / 时间聚合与抽检；可导出 CSV 给主管复盘"
        actions={
          <Button size="sm" variant="outline" disabled={!rows.length} onClick={onExport}>
            <Icon name="download" size={14} />
            导出 CSV
          </Button>
        }
      />

      {/* 聚合卡片：主管一眼看到总量与危级分布 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="违规总数" value={total} tone="default" />
        <SummaryCard label="高危" value={byLevel.high ?? 0} tone="destructive" />
        <SummaryCard label="中危" value={byLevel.mid ?? 0} tone="warning" />
        <SummaryCard label="低危" value={byLevel.low ?? 0} tone="secondary" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-md">
            <Icon name="filter" size={14} className="text-muted-foreground" />
            筛选
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="按违禁词搜索"
            value={word}
            onChange={(e) => setWord(e.target.value)}
            className="w-[200px]"
          />
          <Select value={level} onValueChange={setLevel}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="全部危级" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部危级</SelectItem>
              {Object.keys(LEVEL_LABEL).map((l) => (
                <SelectItem key={l} value={l}>
                  {LEVEL_LABEL[l]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            从
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-[160px]" />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            到
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-[160px]" />
          </label>
          {(word || level !== ALL || dateFrom || dateTo) && (
            <Button size="sm" variant="ghost" onClick={resetFilters}>
              清空筛选
            </Button>
          )}
        </CardContent>
      </Card>

      {/* 按词排行：哪条词最常被打出来，一眼定位重点培训对象 */}
      {topWords.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-md">按词排行</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {topWords.slice(0, 20).map((w) => (
              <span
                key={w.word}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-sm"
                title={`${w.word}：${w.count} 次`}
              >
                {levelBadge(w.level)}
                <span className="font-medium">{w.word}</span>
                <span className="text-muted-foreground">{w.count}</span>
              </span>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {list.isPending ? (
            <p className="p-5 text-sm text-muted-foreground">正在读取违规记录…</p>
          ) : rows.length === 0 ? (
            <EmptyState
              icon="shield"
              title="还没有违规记录"
              desc="敏感词监控实例跑起来并命中之后，记录会按时间出现在这里"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[160px]">时间</TableHead>
                  <TableHead>违禁词</TableHead>
                  <TableHead className="w-[90px]">危级</TableHead>
                  <TableHead className="w-[120px]">坐席</TableHead>
                  <TableHead className="w-[120px]">实例</TableHead>
                  <TableHead>上下文</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r: ViolationEvent) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm text-muted-foreground">{r.ts}</TableCell>
                    <TableCell className="text-base font-medium">{r.word}</TableCell>
                    <TableCell>{levelBadge(r.level)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.seat || '—'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.instanceId || '—'}</TableCell>
                    <TableCell className="max-w-[360px] truncate text-sm text-muted-foreground" title={r.detail}>
                      {r.detail || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        共 {total} 条，当前显示前 {rows.length} 条{rows.length >= PAGE ? '（导出 CSV 含全部）' : ''}
      </p>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'default' | 'destructive' | 'warning' | 'secondary'
}) {
  const toneClass: Record<string, string> = {
    default: 'text-foreground',
    destructive: 'text-destructive',
    warning: 'text-warning',
    secondary: 'text-muted-foreground',
  }
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`mt-1 text-2xl font-semibold ${toneClass[tone]}`}>{value}</p>
      </CardContent>
    </Card>
  )
}
