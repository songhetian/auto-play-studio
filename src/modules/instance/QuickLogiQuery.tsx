import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api, type LogiQueryItem, type LogiRecentItem } from '@/lib/api'
import { MAX_QUERY_NUMBERS, parseWaybills } from '@/lib/logiInput'
import { humanStatus, summarizeRun, type LogiTone } from '@/lib/logiStatus'
import { toCsv, toTsv, logiCsvName } from '@/lib/logiCopy'
import { downloadTextFile } from '@/lib/download'
import { toast } from '@/stores/toastStore'
import { Kbd } from '@/components/ui/kbd'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Icon } from '@/components/icon'

/** 「最近几条」是纯界面偏好，沿用约定存 localStorage，不进引擎配置 */
const LIMIT_KEY = 'logi.recentLimit'
const LIMIT_OPTIONS = [5, 10, 20, 50]

const TONE_CLASS: Record<LogiTone, string> = {
  ok: 'text-ok',
  moving: 'text-primary',
  muted: 'text-muted-foreground',
  bad: 'text-destructive',
}

function readLimit(): number {
  const n = Number(localStorage.getItem(LIMIT_KEY))
  return LIMIT_OPTIONS.includes(n) ? n : 10
}

/**
 * 快速查单：不用 Excel，贴一个或几个单号就能查。
 *
 * 不熟悉电脑的员工多半只是想查一两个单号，走「上传 Excel → 选列 → 跑整批」太重。
 * 这是 logi 的主路径，Excel 批量仍保留在下面当进阶用法。
 */
export function QuickLogiQuery({ id, name }: { id: string; name: string }) {
  const [text, setText] = useState('')
  const [items, setItems] = useState<LogiQueryItem[] | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [recent, setRecent] = useState<LogiRecentItem[]>([])
  const [copiedRecent, setCopiedRecent] = useState(false)
  const [limit, setLimit] = useState(readLimit)

  const numbers = useMemo(() => parseWaybills(text), [text])
  const overflow = numbers.length > MAX_QUERY_NUMBERS
  const failedNos = useMemo(() => (items ?? []).filter((it) => it.ok === false).map((it) => it.no), [items])

  const loadRecent = useCallback(async () => {
    try {
      setRecent((await api.logiRecent(id, limit)).items)
    } catch {
      // 最近记录只是辅助，拿不到不该拦住主流程
    }
  }, [id, limit])

  useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  const runMut = useMutation({
    mutationFn: (nos: string[]) => api.logiQuery(id, nos.join('\n')),
    onSuccess: (r) => {
      setItems(r.items)
      setError('')
      setCopied(false)
      // 结果一句话浮出来，不用用户自己数表格：全中绿、部分蓝、全灭红
      const s = summarizeRun(r.items)
      if (s.failed === 0) toast.success(s.headline)
      else if (s.ok > 0) toast.info(s.headline)
      else toast.error(s.headline)
      void loadRecent()
    },
    onError: (e: Error) => {
      setItems(null)
      setError(e.message)
      toast.error(e.message)
    },
  })

  const query = (nos: string[]) => {
    if (!nos.length) {
      setItems(null)
      const msg = '还没有输入单号，粘贴一个或多个物流单号再查'
      setError(msg)
      toast.info(msg)
      return
    }
    runMut.mutate(nos)
  }

  const clear = () => {
    setText('')
    setItems(null)
    setError('')
  }

  const copyAll = async () => {
    if (!items?.length) return
    try {
      await navigator.clipboard.writeText(toTsv(items))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
      toast.success(`已复制 ${items.length} 条，可直接粘到 Excel`)
    } catch {
      const msg = '复制失败，请手动选中表格内容复制'
      setError(msg)
      toast.error(msg)
    }
  }

  /** 存成 CSV 文件：给要留档、要发出去的场合，比复制多一步但更正式 */
  const exportCsv = () => {
    if (!items?.length) return
    downloadTextFile(logiCsvName(name), toCsv(items))
    toast.success(`已导出 ${items.length} 条查询结果`)
  }

  /**
   * 「最近查过」里既有手动查的，也有整批跑写进缓存的 —— 批量结果没别的出口，
   * 这里给复制的出口，让整批也能像快速查单一样一键带走。
   */
  const copyRecent = async () => {
    if (!recent.length) return
    try {
      await navigator.clipboard.writeText(toTsv(recent))
      setCopiedRecent(true)
      window.setTimeout(() => setCopiedRecent(false), 1500)
      toast.success(`已复制最近 ${recent.length} 条，可直接粘到 Excel`)
    } catch {
      toast.error('复制失败，请手动选中内容复制')
    }
  }

  const exportRecent = () => {
    if (!recent.length) return
    downloadTextFile(logiCsvName(name), toCsv(recent))
    toast.success(`已导出最近 ${recent.length} 条`)
  }

  const summary = items ? summarizeRun(items) : null
  const tone = summary ? (summary.failed === 0 ? 'success' : summary.ok > 0 ? 'warning' : 'destructive') : 'destructive'

  return (
    <Card>
      <CardHeader>
        <CardTitle>快速查单</CardTitle>
        <Badge variant="secondary">不用 Excel，贴单号就能查</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <Textarea
            className="min-h-[84px] font-mono text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // 单号之间要能换行，所以是 Ctrl/Cmd+Enter 而不是 Enter
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                query(numbers)
              }
            }}
            placeholder={'粘贴一个或多个物流单号\n每行一个，也可以逗号、空格隔开'}
            error={overflow}
          />
          {text.length > 0 && (
            <button
              type="button"
              onClick={clear}
              className="absolute right-2 top-2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              title="清空"
              aria-label="清空输入"
            >
              <Icon name="close" size={13} />
            </button>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {numbers.length ? (
              <span className={overflow ? 'text-destructive' : undefined}>
                识别到 {numbers.length} 个单号
                {overflow && `，已超过上限 ${MAX_QUERY_NUMBERS} 个，请分批查`}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <Kbd>Ctrl</Kbd>
                <Kbd>Enter</Kbd>
                快速查询
              </span>
            )}
          </span>
          <Button size="sm" onClick={() => query(numbers)} disabled={runMut.isPending || overflow}>
            <Icon name="search" size={13} className={runMut.isPending ? 'animate-pulse' : undefined} />
            {runMut.isPending ? '查询中…' : '立即查询'}
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <Icon name="error" size={16} />
            <AlertDescription className="leading-relaxed">{error}</AlertDescription>
          </Alert>
        )}

        {items && summary && (
          <div className="space-y-3">
            <Alert variant={tone} className="py-2">
              <Icon name={summary.failed === 0 ? 'success' : summary.ok > 0 ? 'warning' : 'error'} size={16} />
              <AlertDescription className="font-medium">{summary.headline}</AlertDescription>
            </Alert>

            <div className="overflow-hidden rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>单号</TableHead>
                    <TableHead>公司</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>签收时间</TableHead>
                    <TableHead>轨迹</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it, i) => {
                    const hs = humanStatus(it)
                    return (
                      <TableRow key={`${it.no}-${i}`}>
                        <TableCell className="font-mono text-sm">{it.no}</TableCell>
                        <TableCell>{it.company || '—'}</TableCell>
                        <TableCell className={TONE_CLASS[hs.tone]}>
                          <div className="font-medium">{hs.label}</div>
                          {it.ok === false && it.message && it.message !== hs.label && (
                            <div className="mt-0.5 text-xs text-muted-foreground">{it.message}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{it.signed_at || '—'}</TableCell>
                        <TableCell className="max-w-[280px] truncate text-muted-foreground" title={it.trace}>
                          {it.trace || '—'}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between gap-3">
              {failedNos.length > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => query(failedNos)}
                  disabled={runMut.isPending}
                >
                  <Icon name="refresh" size={13} />
                  重查没查到的（{failedNos.length}）
                </Button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={exportCsv}>
                  <Icon name="download" size={13} />
                  导出 CSV
                </Button>
                <Button variant="outline" size="sm" onClick={() => void copyAll()}>
                  <Icon name={copied ? 'check' : 'copy'} size={13} />
                  {copied ? '已复制' : `复制全部（${items.length}）`}
                </Button>
              </div>
            </div>
          </div>
        )}

        {recent.length > 0 && (
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Icon name="clock" size={13} />
                最近查过
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-8" onClick={exportRecent}>
                  <Icon name="download" size={13} />
                  导出
                </Button>
                <Button variant="outline" size="sm" className="h-8" onClick={() => void copyRecent()}>
                  <Icon name={copiedRecent ? 'check' : 'copy'} size={13} />
                  {copiedRecent ? '已复制' : '复制'}
                </Button>
                <Select
                  value={String(limit)}
                  onValueChange={(v) => {
                    const n = Number(v)
                    setLimit(n)
                    localStorage.setItem(LIMIT_KEY, String(n))
                  }}
                >
                  <SelectTrigger className="h-8 w-[110px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LIMIT_OPTIONS.map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        最近 {n} 条
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              {recent.map((r) => {
                const hs = humanStatus({ status: r.status, ok: true })
                return (
                  <div
                    key={r.no}
                    className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm"
                  >
                    <span className="w-[128px] flex-none truncate font-mono">{r.no}</span>
                    <span className={TONE_CLASS[hs.tone]}>{hs.label}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.company}</span>
                    <span className="flex-none text-xs text-muted-foreground">{r.updated_at}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 flex-none px-2"
                      onClick={() => {
                        setText(r.no)
                        query([r.no])
                      }}
                    >
                      <Icon name="refresh" size={12} />
                      重查
                    </Button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
