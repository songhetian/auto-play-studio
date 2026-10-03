import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { motion } from 'motion/react'
import type { KbFolder, KbHit } from '@/lib/api'
import { hasFolderPicker, ipc } from '@/lib/ipc'
import { highlightSegments, searchTerms } from '@/lib/kbFilter'
import { fadeItem, staggerList } from '@/lib/motion'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Icon, type IconName } from '@/components/icon'
import { ConfirmDialog } from '@/components/blocks/confirm-dialog'
import { EmptyState } from '@/components/blocks/empty-state'
import { PageHeader } from '@/components/blocks/page-header'
import { StatCard } from '@/components/blocks/stat-card'
import {
  useKbAddFolder,
  useKbClearHistory,
  useKbHistory,
  useKbOpenFile,
  useKbReindex,
  useKbRemoveFolder,
  useKbSearch,
  useKbStatus,
} from '@/modules/kb/useKb'

/**
 * 知识库：把这些文件夹登记进来，按**内容**找文件。
 *
 * 页面的组织顺序跟着「我会遇到什么问题」走：
 *   还不能用 → 先引导登记文件夹；能用了 → 搜索是主角；
 *   索引在跑 → 把进度说出来（否则用户以为加了文件夹没反应）；
 *   读不出来的文件 → 明说跳过了哪几个，不装作无事发生。
 *
 * 搜索是**提交式**（回车 / 点按钮）而不是输入即搜：引擎按查询串记历史，
 * 边打边搜会把「退」「退款」「退款政」「退款政策」四条前缀全记进历史里。
 */

/** 文件类型 → 图标。xlsx/pptx 与纯文本分开，扫结果时靠形状就分得出来 */
const TYPE_ICON: Record<string, IconName> = {
  xlsx: 'sheet',
  pptx: 'boxes',
  pdf: 'fileText',
  docx: 'fileText',
  md: 'fileText',
  txt: 'fileText',
}

function fileIcon(type: string): IconName {
  return TYPE_ICON[type] ?? 'fileText'
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 引擎给的是 Unix 秒（st_mtime），不是毫秒 —— 少乘 1000 会显示成 1970 年 */
function formatDate(seconds: number): string {
  if (!seconds) return ''
  const d = new Date(seconds * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function KbPage() {
  const [draft, setDraft] = useState('')
  /** 已提交的查询。与 draft 分开：历史记录的是「用户真的要搜的那一下」 */
  const [query, setQuery] = useState('')
  /** 没有系统目录选择框时（浏览器预览）的降级入口：手填路径 */
  const [manualPath, setManualPath] = useState('')
  const [note, setNote] = useState('')
  const [pendingRemove, setPendingRemove] = useState<KbFolder | null>(null)
  /** 反馈横幅在页面顶部。底部（注销文件夹）触发的动作，横幅会落在视口外 —— 用户以为没反应 */
  const noteRef = useRef<HTMLDivElement>(null)

  const { data: status } = useKbStatus()
  const { data: history } = useKbHistory()
  const { data: found, isFetching, error } = useKbSearch(query)

  const addFolder = useKbAddFolder()
  const removeFolder = useKbRemoveFolder()
  const reindex = useKbReindex()
  const clearHistory = useKbClearHistory()
  const openFile = useKbOpenFile()

  const folders = status?.folders ?? []
  const indexing = status?.indexing
  const failed = status?.failed ?? []
  const results = found?.results ?? []
  const terms = useMemo(() => searchTerms(query), [query])

  // `block: 'nearest'` 是最小滚动：横幅本来就看得见就一动不动，被挡在上面才把它带下来
  useEffect(() => {
    if (note) noteRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [note])

  const addPath = async (raw: string) => {
    const path = raw.trim()
    if (!path) return
    setNote('')
    try {
      const r = await addFolder.mutateAsync(path)
      setManualPath('')
      setNote(
        r.started
          ? `已登记「${r.folder?.name ?? path}」，正在后台索引…`
          : '已登记。当前这轮索引跑完会自动补上，不用再点一次',
      )
    } catch (e) {
      setNote((e as Error).message)
    }
  }

  const onAdd = async () => {
    const picked = await ipc.selectFolder()
    if (!picked) return
    await addPath(picked)
  }

  const onOpen = async (hit: KbHit) => {
    setNote('')
    try {
      await openFile.mutateAsync(hit.path)
    } catch (e) {
      setNote((e as Error).message)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setQuery(draft.trim())
  }

  const runHistory = (q: string) => {
    setDraft(q)
    setQuery(q)
  }

  const clearAll = () => {
    setDraft('')
    setQuery('')
  }

  const doRemove = async () => {
    if (!pendingRemove) return
    setNote('')
    try {
      const r = await removeFolder.mutateAsync(pendingRemove.path)
      setNote(`已注销「${pendingRemove.name}」，撤回 ${r.removed} 处索引（磁盘上的文件没有动）`)
      setPendingRemove(null)
    } catch (e) {
      setNote((e as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-[1240px] space-y-4 p-5">
      <PageHeader
        icon="database"
        title="知识库"
        desc="把常查的资料文件夹登记进来，按内容或拼音找文件；命中后点一下就能用系统程序打开原文"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={reindex.isPending || !!indexing?.running}
              title={indexing?.running ? '正在索引，跑完再点' : '重扫已登记文件夹，只重抽改动过的文件'}
              onClick={() =>
                void reindex.mutateAsync().then(
                  (r) => setNote(r.started ? '已开始重扫…' : '当前这轮索引还没跑完'),
                  (e: Error) => setNote(e.message),
                )
              }
            >
              <Icon name="refresh" size={14} />
              重新索引
            </Button>
            <Button size="sm" disabled={addFolder.isPending} onClick={() => void onAdd()}>
              <Icon name="plus" size={14} />
              添加文件夹
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

      {indexing?.running && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Icon name="refresh" size={13} className="animate-spin" />
            </span>
            <span className="font-medium">正在建立索引</span>
            <span className="font-mono tabular-nums text-muted-foreground">
              {indexing.total ? `${indexing.done} / ${indexing.total}` : '正在扫描…'}
            </span>
            <div className="flex-1" />
            {indexing.current && (
              <span className="max-w-[320px] truncate font-mono text-[11.5px] text-muted-foreground" title={indexing.current}>
                {indexing.current}
              </span>
            )}
          </div>
          {/* 文件多的时候索引要跑一阵；进度条比一个转圈图标更能回答「还要多久」 */}
          <Progress
            className="mt-2.5"
            value={indexing.total ? Math.round((indexing.done / indexing.total) * 100) : 5}
          />
        </Card>
      )}

      {!!failed.length && (
        <Alert variant="warning">
          <Icon name="warning" size={16} />
          <AlertDescription>
            <div className="font-medium">{failed.length} 个文件读不出来，已跳过其余照常索引</div>
            <ul className="mt-1 space-y-0.5 font-mono text-[11.5px]">
              {failed.slice(0, 5).map((f, i) => (
                <li key={i} className="truncate" title={f}>
                  {f}
                </li>
              ))}
            </ul>
            {failed.length > 5 && <div className="mt-1">…等 {failed.length} 个</div>}
          </AlertDescription>
        </Alert>
      )}

      {/* ── 搜索（页面主体） ── */}
      <Card className="overflow-hidden">
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-[240px] flex-1">
            <Icon
              name="search"
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              autoFocus
              className="h-9 pl-9 text-[13px]"
              placeholder="搜资料内容…支持中文、拼音首字母（如 tkzc）与 type:pdf"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={!draft.trim()}>
            搜索
          </Button>
          {(draft || query) && (
            <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
              <Icon name="close" size={13} />
              清空
            </Button>
          )}
        </form>

        {!!history?.items.length && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
            <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
              <Icon name="clock" size={12} />
              最近
            </span>
            {history.items.map((h) => (
              <button
                key={h.query}
                type="button"
                onClick={() => runHistory(h.query)}
                title={`上次搜到 ${h.resultCount} 条`}
                className="rounded-md border border-border px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {h.query}
              </button>
            ))}
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11.5px] text-muted-foreground"
              disabled={clearHistory.isPending}
              onClick={() => void clearHistory.mutateAsync().then(() => setNote('搜索历史已清空'))}
            >
              清除历史
            </Button>
          </div>
        )}

        {!folders.length ? (
          <EmptyState
            icon="folder"
            title="还没有登记任何文件夹"
            desc="知识库不搬动、不修改你的文件，只是把这些文件夹登记进来做一份内容索引。登记后引擎会在后台扫描，几百份文档通常几秒内完成。"
            actions={
              <>
                {hasFolderPicker && (
                  <Button size="sm" onClick={() => void onAdd()}>
                    <Icon name="plus" size={13} />
                    添加文件夹
                  </Button>
                )}
                <div className="flex items-center gap-2">
                  <Input
                    className="h-7 w-[260px] text-[12px]"
                    placeholder="或直接粘贴文件夹路径"
                    value={manualPath}
                    onChange={(e) => setManualPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addPath(manualPath)
                    }}
                  />
                  <Button variant="outline" size="sm" disabled={!manualPath.trim()} onClick={() => void addPath(manualPath)}>
                    登记
                  </Button>
                </div>
              </>
            }
          />
        ) : !query ? (
          <EmptyState
            icon="search"
            title="输入关键词开始找"
            desc="搜的是文件里的正文，不只是文件名。多个词用空格隔开（越收越窄）；也可以只打拼音首字母 —— 比如 tkzc 能找到「退款政策」。"
          />
        ) : isFetching && !found ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-[72px] animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : error ? (
          <EmptyState icon="error" title="搜索失败" desc={(error as Error).message} actions={<Button variant="outline" size="sm" onClick={clearAll}>清空</Button>} />
        ) : !results.length ? (
          <EmptyState
            icon="search"
            title={`没有找到「${query}」`}
            desc="换个说法试试，或减少关键词 —— 多个词默认要求全部命中。也可能是这份资料还没被登记进来。"
            actions={
              <Button variant="outline" size="sm" onClick={clearAll}>
                重新搜
              </Button>
            }
          />
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-[11.5px] text-muted-foreground">
              <span>
                找到 <span className="font-mono text-foreground">{results.length}</span> 个文件
                {found && found.count !== results.length && '（已截断）'}
              </span>
              <div className="flex-1" />
              <span>按相关度排序</span>
            </div>
            <motion.div variants={staggerList} initial="hidden" animate="show">
              {results.map((hit) => (
                <motion.div key={hit.path} variants={fadeItem} className="group border-b border-border last:border-0">
                  <div className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Icon name={fileIcon(hit.fileType)} size={14} />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <button
                          type="button"
                          className="max-w-[420px] truncate text-[13px] font-medium hover:text-primary hover:underline"
                          title={hit.path}
                          onClick={() => void onOpen(hit)}
                        >
                          {hit.fileName}
                        </button>
                        <Badge variant="outline">{hit.fileType}</Badge>
                        {hit.matchCount > 1 && <Badge variant="secondary">命中 {hit.matchCount} 处</Badge>}
                        {hit.matchMode === 'or' && <Badge variant="warning">已放宽匹配</Badge>}
                        {hit.truncated && <Badge variant="outline">只索引了前半段</Badge>}
                      </div>

                      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11.5px] text-muted-foreground">
                        <span className="truncate font-mono" title={hit.path}>
                          {hit.path}
                        </span>
                        <span className="shrink-0">{formatSize(hit.size)}</span>
                        {!!hit.mtime && <span className="shrink-0">{formatDate(hit.mtime)}</span>}
                      </div>

                      {!!hit.snippets.length && (
                        <div className="mt-2 space-y-1">
                          {hit.snippets.map((s, i) => (
                            <div
                              key={i}
                              className="flex gap-2.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-[12px] leading-relaxed"
                            >
                              <span className="w-7 shrink-0 select-none text-right font-mono text-[11px] text-muted-foreground/70">
                                {s.line}
                              </span>
                              <span className="min-w-0 break-words">
                                {highlightSegments(s.text, terms).map((seg, j) =>
                                  seg.hit ? (
                                    <mark key={j} className="rounded-[3px] bg-primary/15 px-0.5 text-foreground">
                                      {seg.text}
                                    </mark>
                                  ) : (
                                    <span key={j}>{seg.text}</span>
                                  ),
                                )}
                              </span>
                            </div>
                          ))}
                          {hit.matchCount > hit.snippets.length && (
                            <div className="pl-10 text-[11.5px] text-muted-foreground">
                              …还有 {hit.matchCount - hit.snippets.length} 处命中，打开原文件查看
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="在文件管理器中显示"
                        onClick={() => void ipc.showItem(hit.path)}
                      >
                        <Icon name="folder" size={14} />
                      </Button>
                      <Button variant="outline" size="sm" disabled={openFile.isPending} onClick={() => void onOpen(hit)}>
                        <Icon name="externalLink" size={13} />
                        打开
                      </Button>
                    </div>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          </>
        )}
      </Card>

      {/* ── 索引范围 ── */}
      <div className="flex items-center gap-2 pt-1">
        <Icon name="database" size={14} className="text-muted-foreground" />
        <span className="text-[13px] font-medium">索引范围</span>
        <span className="text-[11.5px] text-muted-foreground">支持 pdf / docx / xlsx / pptx / md / txt</span>
      </div>

      <motion.div variants={staggerList} initial="hidden" animate="show" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="已索引文件" value={status?.fileCount ?? 0} icon="fileText" hint="命中一个文件只算一个，不按段落重复计" />
        <StatCard label="索引段落" value={status?.docCount ?? 0} icon="boxes" hint="正文按段落切开后的条数，决定搜索的粒度" />
        <StatCard
          label="登记文件夹"
          value={folders.length}
          icon="folder"
          tone={failed.length ? 'warn' : 'default'}
          hint={failed.length ? `${failed.length} 个文件读不出来` : '注销只是撤回索引，不动磁盘文件'}
        />
      </motion.div>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="folder" size={14} className="text-muted-foreground" />
            已登记的文件夹
          </CardTitle>
          <Badge variant="secondary">{folders.length} 个</Badge>
        </CardHeader>

        {!folders.length ? (
          <div className="px-5 py-6 text-center text-[12.5px] text-muted-foreground">
            还没有登记文件夹。引擎只会扫描这里列出来的目录，不会碰其它地方。
          </div>
        ) : (
          <div className="divide-y divide-border">
            {folders.map((f) => (
              <div key={f.path} className="flex items-center gap-3 px-5 py-3">
                <Icon name="folder" size={15} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium" title={f.path}>
                      {f.name}
                    </span>
                    {f.docCount === 0 && <Badge variant="outline">暂无文档</Badge>}
                  </div>
                  <div className="truncate font-mono text-[11.5px] text-muted-foreground" title={f.path}>
                    {f.path}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">{f.docCount} 段</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="注销这个文件夹"
                  onClick={() => setPendingRemove(f)}
                >
                  <Icon name="trash" size={14} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={!!pendingRemove}
        onOpenChange={(v) => !v && setPendingRemove(null)}
        icon="trash"
        destructive
        title={`注销「${pendingRemove?.name ?? ''}」？`}
        desc="会把它下面的文档从索引里撤回，之后的搜索不再命中这些文件。磁盘上的原文件不会被删除或修改。"
        confirmText="注销"
        pending={removeFolder.isPending}
        onConfirm={() => void doRemove()}
      >
        <div className="rounded-lg border border-border px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
          {pendingRemove?.path}
        </div>
      </ConfirmDialog>
    </div>
  )
}
