import { useEffect, useRef, useState, type FormEvent } from 'react'
import { motion } from 'motion/react'
import { api, type PrepChange, type PrepIssue, type PrepLog, type PrepReport } from '@/lib/api'
import { hasWorkbookPicker, ipc } from '@/lib/ipc'
import { fadeItem, staggerList } from '@/lib/motion'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Icon } from '@/components/icon'
import { EmptyState } from '@/components/blocks/empty-state'
import { PageHeader } from '@/components/blocks/page-header'
import { StatCard } from '@/components/blocks/stat-card'
import { useExcelClean, useExcelOpen, useExcelReport } from '@/modules/excel/useExcelPrep'

/**
 * Excel 体检与整理：跑之前先把表看一遍，再出一份收拾干净的新文件。
 *
 * 三个刻意的取舍：
 *
 * 1. **主键列不预选。** 主键选错，报告里的重复判定就是错的，而页面看起来一切正常。
 *    所以默认留空（跳过所有主键判定），由用户自己指一列 —— 空着的时候页面会明说
 *    「还没查重复」。
 * 2. **`risk` 级不藏在默认里。** 主键重复只留第一行 = 同一条工单只做一遍，
 *    这种事不能替用户决定：默认关，勾选才应用，而且要写在按钮旁边。
 * 3. **原文件只读。** 整出一份「原名_已整理.xlsx」，页面把台账摊开给用户核对，
 *    任何一处改动都能在原文件里对上号。
 */

/** 上限：一列里 500 行主键带空格就会报 500 条，铺满屏幕反而看不出结构问题 */
const MAX_ISSUES = 30

type Severity = PrepIssue['severity']

const SEVERITY: Record<Severity, { label: string; badge: 'success' | 'warning' | 'outline'; hint: string }> = {
  fix: { label: '会自动处理', badge: 'success', hint: '整理时直接应用' },
  risk: { label: '需要你确认', badge: 'warning', hint: '改了会有业务代价，默认不动' },
  info: { label: '只提示', badge: 'outline', hint: '一个字都不会改' },
}

const ORDER: Severity[] = ['fix', 'risk', 'info']

function listNumbers(nums: number[], head = 8): string {
  const shown = nums.slice(0, head)
  return shown.join('、') + (nums.length > shown.length ? ` 等 ${nums.length} 处` : '')
}

/** 问题落在哪儿。表头问题的主语是列，行级问题的 `cols` 是空的 */
function where(issue: PrepIssue): string {
  const parts: string[] = []
  if (issue.cols.length) parts.push(`第 ${listNumbers(issue.cols)} 列`)
  if (issue.rows.length) parts.push(`第 ${listNumbers(issue.rows)} 行`)
  return parts.join(' · ')
}

function changeTarget(c: PrepChange): string {
  if (c.row && c.col) return `第 ${c.row} 行 · 第 ${c.col} 列`
  if (c.row) return `第 ${c.row} 行`
  return `第 ${c.col} 列`
}

function cellText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '（空）'
  return String(v)
}

export default function ExcelPrepPage() {
  const [path, setPath] = useState('')
  const [manual, setManual] = useState('')
  /** 主键列。空 = 用户还没选，主键相关的判定整体跳过 —— 页面会明说这一点 */
  const [keyCol, setKeyCol] = useState('')
  const [acceptRisk, setAcceptRisk] = useState(false)
  const [log, setLog] = useState<PrepLog | null>(null)
  const [note, setNote] = useState('')
  const noteRef = useRef<HTMLDivElement>(null)

  const { data: report, isFetching, error } = useExcelReport(path, keyCol)
  const clean = useExcelClean()
  const open = useExcelOpen()

  // 底部触发的动作，横幅渲染在顶部会落在视口外 —— 用户以为没反应。
  // `block: 'nearest'` 是最小滚动：本来就看得见就一动不动。
  useEffect(() => {
    if (note) noteRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [note])

  const load = (p: string) => {
    const next = p.trim()
    if (!next) return
    setPath(next)
    setKeyCol('')
    setLog(null)
    setNote('')
  }

  const pick = async () => {
    const picked = await ipc.selectWorkbook()
    if (picked) load(picked)
  }

  const submitPath = (e: FormEvent) => {
    e.preventDefault()
    load(manual)
    setManual('')
  }

  const doClean = async () => {
    if (!report) return
    setNote('')
    try {
      const r = await clean.mutateAsync({ path: report.path, keyCol: report.keyCol, acceptRisk })
      setLog(r)
      setNote(`已整理出「${r.fileName}」，共 ${r.changes.length} 处改动；原文件没有动`)
    } catch (e) {
      setNote((e as Error).message)
    }
  }

  const doOpen = async (target: string) => {
    setNote('')
    try {
      await open.mutateAsync(target)
    } catch (e) {
      setNote((e as Error).message)
    }
  }

  const issues = report?.issues ?? []
  const bySeverity = (s: Severity) => issues.filter((i) => i.severity === s)
  const fixable = bySeverity('fix')
  const risky = bySeverity('risk')
  const infos = bySeverity('info')
  const willApply = fixable.length + (acceptRisk ? risky.length : 0)
  const columnNames = (report?.columns ?? []).filter((c): c is string => !!c)

  return (
    <div className="mx-auto max-w-[1240px] space-y-4 p-5">
      <PageHeader
        icon="sheet"
        title="Excel 体检与整理"
        desc="跑之前先看一遍表：哪几行有毛病、会不会让整行失败；一键整理出新文件，并留下逐处改动台账。原文件从不改动"
        actions={
          <>
            {path && (
              <Button variant="outline" size="sm" onClick={() => load(path)} title="重新读一遍这个文件">
                <Icon name="refresh" size={14} />
                重新体检
              </Button>
            )}
            <Button size="sm" onClick={() => void pick()}>
              <Icon name="upload" size={14} />
              选择表格
            </Button>
          </>
        }
      />

      {note && (
        <Alert ref={noteRef} variant="info">
          <Icon name="info" size={16} />
          <AlertDescription className="flex items-center gap-3">
            <span>{note}</span>
            <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => setNote('')}>
              <Icon name="close" size={12} />
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!path && (
        <Card>
          <EmptyState
            icon="sheet"
            title="先选一个要跑的表格"
            desc="体检是只读的：它只把表扫一遍，告诉你哪几行会在执行时出问题。整理也是出新文件，原表一个字都不改"
            actions={
              <>
                <Button size="sm" onClick={() => void pick()}>
                  <Icon name="upload" size={14} />
                  选择表格
                </Button>
                {!hasWorkbookPicker && (
                  <form onSubmit={submitPath} className="flex items-center gap-2">
                    <Input
                      className="h-8 w-[320px]"
                      placeholder="粘贴表格完整路径，例如 D:\表格\订单.xlsx"
                      value={manual}
                      onChange={(e) => setManual(e.target.value)}
                    />
                    <Button type="submit" variant="outline" size="sm">
                      体检
                    </Button>
                  </form>
                )}
              </>
            }
          />
        </Card>
      )}

      {path && error && (
        <Alert variant="destructive">
          <Icon name="error" size={16} />
          <AlertDescription className="flex items-center gap-3">
            <span>{(error as Error).message}</span>
            <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => setPath('')}>
              换一个文件
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {path && !error && isFetching && !report && (
        <Card className="p-6 text-[13px] text-muted-foreground">正在读表…</Card>
      )}

      {path && report && (
        <ReportBody
          report={report}
          keyCol={keyCol}
          onKeyCol={(v) => {
            setKeyCol(v)
            setLog(null)
          }}
          columnNames={columnNames}
          fixable={fixable}
          risky={risky}
          infos={infos}
          acceptRisk={acceptRisk}
          onAcceptRisk={(v) => {
            setAcceptRisk(v)
            setLog(null)
          }}
          willApply={willApply}
          cleaning={clean.isPending}
          onClean={() => void doClean()}
        />
      )}

      {log && <ChangeLogCard log={log} onOpen={() => void doOpen(log.output)} />}
    </div>
  )
}

/** 报告主体：先给数字，再给问题清单，最后才是「要做什么」 */
function ReportBody({
  report,
  keyCol,
  onKeyCol,
  columnNames,
  fixable,
  risky,
  infos,
  acceptRisk,
  onAcceptRisk,
  willApply,
  cleaning,
  onClean,
}: {
  report: PrepReport
  keyCol: string
  onKeyCol: (v: string) => void
  columnNames: string[]
  fixable: PrepIssue[]
  risky: PrepIssue[]
  infos: PrepIssue[]
  acceptRisk: boolean
  onAcceptRisk: (v: boolean) => void
  willApply: number
  cleaning: boolean
  onClean: () => void
}) {
  const [shown, setShown] = useState(MAX_ISSUES)
  const ordered = ORDER.flatMap((s) => (s === 'fix' ? fixable : s === 'risk' ? risky : infos))
  const visible = ordered.slice(0, shown)

  return (
    <motion.div variants={staggerList} initial="hidden" animate="show" className="space-y-4">
      <motion.div variants={fadeItem} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="工作表" value={report.sheet} hint={`表头在第 ${report.headerRow} 行`} icon="table" />
        <StatCard label="列数" value={report.columns.length} hint={columnNames.join('、') || '没有列名'} />
        <StatCard label="数据行数" value={report.dataRows} hint="含空行，与执行时的行号一致" />
        <StatCard
          label="会自动处理"
          value={fixable.length}
          tone={fixable.length ? 'brand' : 'default'}
          hint={risky.length ? `另有 ${risky.length} 条需要你确认` : '没有需要确认的'}
        />
      </motion.div>

      <motion.div variants={fadeItem}>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[13.5px]">按哪一列查重复</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Select value={keyCol} onValueChange={onKeyCol}>
              <SelectTrigger className="h-8 w-[200px]">
                <SelectValue placeholder="选择主键列" />
              </SelectTrigger>
              <SelectContent>
                {columnNames.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[12.5px] text-muted-foreground">
              {keyCol
                ? '主键重复只保留第一行（有业务代价，默认不应用）'
                : '还没选 —— 现在跳过「主键为空」「主键带空白」「主键重复」这三项判定'}
            </span>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div variants={fadeItem}>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[13.5px]">
              体检结果
              {ordered.length > 0 && <span className="ml-2 text-[12.5px] font-normal text-muted-foreground">{ordered.length} 条</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {ordered.length === 0 && (
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Icon name="success" size={15} className="text-[hsl(var(--ok))]" />
                这一遍没看出问题：没有空行、没有重复行，主键也没有多余的空白
              </div>
            )}

            {visible.map((issue, i) => {
              const meta = SEVERITY[issue.severity]
              return (
                <div key={`${issue.kind}-${i}`} className="flex items-start gap-2.5 rounded-lg border border-border p-2.5">
                  <Badge variant={meta.badge} className="mt-0.5 shrink-0">
                    {meta.label}
                  </Badge>
                  <div className="min-w-0">
                    <div className="text-[13px] leading-relaxed">{issue.detail}</div>
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                      {where(issue)} · {meta.hint}
                    </div>
                  </div>
                </div>
              )
            })}

            {ordered.length > shown && (
              <Button variant="ghost" size="sm" className="h-7" onClick={() => setShown(shown + MAX_ISSUES)}>
                还有 {ordered.length - shown} 条同类问题，继续显示
              </Button>
            )}
          </CardContent>
        </Card>
      </motion.div>

      <motion.div variants={fadeItem}>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-[13.5px]">整理</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-[12.5px] leading-relaxed text-muted-foreground">
              出一份「原名_已整理.xlsx」，放在原文件旁边，原文件保持只读。整理后每一处改动都会列在下面，
              可以照着原表核对。
            </div>

            {risky.length > 0 && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-2.5">
                <Switch checked={acceptRisk} onCheckedChange={onAcceptRisk} className="mt-0.5" />
                <span className="text-[12.5px] leading-relaxed">
                  <span className="font-medium text-foreground">主键重复只保留第一行（{risky.length} 条）</span>
                  <span className="block text-muted-foreground">
                    不勾选就不动它们。同一条工单做两遍意味着重复退款这类事，得你自己确认过再勾
                  </span>
                </span>
              </label>
            )}

            <div className="flex items-center gap-3">
              <Button size="sm" disabled={willApply === 0 || cleaning} onClick={onClean}>
                <Icon name="wand" size={14} />
                {cleaning ? '整理中…' : '整理出新文件'}
              </Button>
              <span className="text-[12.5px] text-muted-foreground">
                {willApply === 0
                  ? infos.length
                    ? '这一遍没有能自动处理的问题，只有提示'
                    : '这一遍没有什么要整理的'
                  : `会处理 ${willApply} 条`}
              </span>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  )
}

/** 台账：整理后逐处改动，行号一律是**原文件**的 —— 输出的行号已经漂了 */
function ChangeLogCard({ log, onOpen }: { log: PrepLog; onOpen: () => void }) {
  const removed = log.changes.filter((c) => c.col === 0).length
  const trimmed = log.changes.filter((c) => c.col > 0).length

  return (
    <motion.div variants={fadeItem} initial="hidden" animate="show">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-[13.5px]">
            改动台账
            <Badge variant="success">{log.fileName}</Badge>
            <span className="text-[12.5px] font-normal text-muted-foreground">
              删掉 {removed} 行{trimmed ? `、改了 ${trimmed} 处` : ''}；留下的 {log.rowsKept.length - 1} 行数据来自原文件的第{' '}
              {listNumbers(log.rowsKept.slice(1), 6)} 行
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {log.changes.length === 0 && (
            <div className="text-[13px] text-muted-foreground">这一遍没有改动 —— 输出文件与原文件内容一致</div>
          )}

          <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
            {log.changes.map((c, i) => (
              <div key={i} className="flex items-start gap-2.5 rounded-lg border border-border p-2.5">
                <Badge variant={c.col === 0 ? 'destructive' : 'secondary'} className="mt-0.5 shrink-0">
                  {c.col === 0 ? '删行' : '改值'}
                </Badge>
                <div className="min-w-0">
                  <div className="font-mono text-[12px] text-muted-foreground">{changeTarget(c)}</div>
                  {c.col > 0 && (
                    /*
                     * `whitespace-pre-wrap` 是必须的：这一格改的往往就是空白，
                     * 而默认的 white-space 会把「  A005  → A005」折成「A005 → A005」——
                     * 看起来像什么都没改，台账就白留了。
                     */
                    <div className="whitespace-pre-wrap text-[13px]">
                      <span className="text-muted-foreground line-through">{cellText(c.before)}</span>
                      <span className="mx-1.5 text-muted-foreground">→</span>
                      <span>{cellText(c.after)}</span>
                    </div>
                  )}
                  <div className="text-[12.5px] text-muted-foreground">{c.detail}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" onClick={onOpen}>
              <Icon name="externalLink" size={14} />
              打开整理后的文件
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={api.excelDownloadUrl(log.output)} download={log.fileName}>
                <Icon name="download" size={14} />
                下载
              </a>
            </Button>
            <span className="text-[12.5px] text-muted-foreground">就在原文件旁边：{log.output}</span>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}
