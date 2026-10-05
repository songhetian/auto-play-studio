import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { motion } from 'motion/react'
import type { KbFolder, KbHit } from '@/lib/api'
import { hasFolderPicker, ipc } from '@/lib/ipc'
import { highlightSegments, searchTerms } from '@/lib/kbFilter'
import { cn } from '@/lib/utils'
import { fadeItem, staggerList } from '@/lib/motion'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Icon, type IconName } from '@/components/icon'
import { KB_TABS, tabById, type KbTabId } from '@/modules/kb/kbTabs'
import { AssistTargetBar } from '@/modules/kb/AssistTargetBar'
import { useAssistFill } from '@/modules/kb/useAssist'
import { toast } from '@/stores/toastStore'
import { ConfirmDialog } from '@/components/blocks/confirm-dialog'
import { FolderDrop } from '@/components/FolderDrop'
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
  /**
   * 资料管理 / 搜索浏览。
   *
   * 原来两类完全不同的场景挤在一个长滚动页里：进来先过一屏「怎么用」的说明，
   * 搜索框还要往下滚才够得着。拆成两页后，**查资料的第一屏就是搜索框**。
   * 归属规则见 `kbTabs.ts`（那里有测试守着）。
   */
  const [tab, setTab] = useState<KbTabId>('search')
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
  /** 把某一段话术填进客服客户端输入框（不发送） */
  const fill = useAssistFill()

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

  /** 拖进来一批文件夹：逐个登记，失败的单独点名，不影响其它 */
  const addMany = async (paths: string[]) => {
    setNote('')
    const done: string[] = []
    const failed: string[] = []
    for (const p of paths) {
      try {
        const r = await addFolder.mutateAsync(p)
        done.push(r.folder?.name ?? p)
      } catch (e) {
        failed.push(`${p}：${(e as Error).message}`)
      }
    }
    if (done.length) setNote(`已登记 ${done.length} 个文件夹：${done.join('、')}，正在后台索引…`)
    if (failed.length) setNote((n) => [n, `以下 ${failed.length} 个失败：${failed.join('；')}`].filter(Boolean).join(' '))
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

  /**
   * 把一段话术填进客服客户端的输入框。
   *
   * **不发送** —— 客服自己看着按发送键。这是整条链路里唯一的人工闸门，
   * 也是它相比「自动回复」唯一安全的地方：错字在发出去之前就看见了。
   */
  const onFill = (text: string) => {
    fill.mutate(text, {
      onSuccess: (r) => toast.success(`已填进「${r.window}」的输入框，自己看一眼再发`),
      onError: (e: Error) => toast.error(e.message),
    })
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

  const activeTab = tabById(tab)

  return (
    <div className="mx-auto max-w-[1240px] space-y-5 p-5">
      <PageHeader
        icon="database"
        title="知识库"
        // 副标题跟着当前 Tab 走：两个 Tab 管的是完全不同的两件事
        desc={activeTab.desc}
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

      {/* 资料管理 / 搜索浏览：两个独立场景各占一个 Tab，不共用一条滚动流 */}
      <div className="flex items-center gap-1 border-b border-border" role="tablist" aria-label="知识库分区">
        {KB_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 pb-2 text-base transition-colors',
              tab === t.id
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon name={t.icon} size={14} className={tab === t.id ? 'text-primary' : undefined} />
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        <span className="pb-2 text-xs text-muted-foreground">
          {tab === 'search' ? (
            <>
              已登记 <span className="font-mono text-foreground">{folders.length}</span> 个文件夹
            </>
          ) : (
            '登记与索引配置'
          )}
        </span>
      </div>

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

      {/* 索引进度与失败清单属于「资料管理」：它关心的是资料库状态，不是检索 */}
      {tab === 'manage' && indexing?.running && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Icon name="refresh" size={13} className="animate-spin" />
            </span>
            <span className="font-medium">正在建立索引</span>
            <span className="font-mono tabular-nums text-muted-foreground">
              {indexing.total ? `${indexing.done} / ${indexing.total}` : '正在扫描…'}
            </span>
            <div className="flex-1" />
            {indexing.current && (
              <span className="max-w-[320px] truncate font-mono text-xs text-muted-foreground" title={indexing.current}>
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

      {tab === 'manage' && !!failed.length && (
        <Alert variant="warning">
          <Icon name="warning" size={16} />
          <AlertDescription>
            <div className="font-medium">{failed.length} 个文件读不出来，已跳过其余照常索引</div>
            <ul className="mt-1 space-y-0.5 font-mono text-xs">
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

      {/* ── 搜索浏览：搜索框 + 历史 + 结果 ── */}
      {tab === 'search' && <AssistTargetBar />}

      {tab === 'search' && (
        <Card className="overflow-hidden">
        {/* 还没登记资料时不显示搜索框：没有内容可搜，给个输入框只会让人反复试。 */}
        {!!folders.length && (
          <form onSubmit={submit} className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <div className="relative min-w-[240px] flex-1">
              <Icon
                name="search"
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                autoFocus
                className="h-9 pl-9 text-base"
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
        )}

        {!!history?.items.length && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Icon name="clock" size={12} />
              最近
            </span>
            {history.items.map((h) => (
              <button
                key={h.query}
                type="button"
                onClick={() => runHistory(h.query)}
                title={`上次搜到 ${h.resultCount} 条`}
                className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {h.query}
              </button>
            ))}
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs text-muted-foreground"
              disabled={clearHistory.isPending}
              onClick={() => void clearHistory.mutateAsync().then(() => setNote('搜索历史已清空'))}
            >
              清除历史
            </Button>
          </div>
        )}

        {/*
          还没登记任何资料时，搜索框没有意义（无内容可搜），
          所以把它收起来，只给"登记文件夹"这一个明确的下一步。
          原来搜索框常驻 + 空态里再塞一个手填输入框，两处入口并排挤在一起，
          看着像两个半成品。
        */}
        {!folders.length ? (
          <div className="px-6 py-12 text-center">
            <span className="mx-auto flex size-11 items-center justify-center rounded-xl border border-border bg-muted/60 text-muted-foreground">
              <Icon name="folder" size={20} />
            </span>
            <div className="mt-3 text-base font-medium">还没有登记任何文件夹</div>
            <p className="mx-auto mt-1 max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
              知识库不搬动、不修改你的文件，只是把这些文件夹登记进来做一份内容索引。
              登记后引擎会在后台扫描，几百份文档通常几秒内完成。
            </p>

            <div className="mx-auto mt-5 max-w-[480px] space-y-2.5 text-left">
              {/* 拖文件夹进来：用户手上拿的是一个文件夹，不是路径字符串。
                  文件夹拖到 <input> 里拿不到 files（Web 规范限制），要靠
                  webkitGetAsEntry 逐层展开 —— 这是少数必须用非标准 API 的场景。 */}
              <FolderDrop onFolders={(paths) => void addMany(paths)} />

              {hasFolderPicker ? (
                <Button size="sm" className="w-full" onClick={() => void onAdd()}>
                  <Icon name="plus" size={13} />
                  选择文件夹并登记
                </Button>
              ) : (
                <p className="rounded-md border border-warn/35 bg-warn/8 px-3 py-2 text-sm leading-relaxed text-muted-foreground">
                  当前环境无法弹出系统目录选择框（需要桌面版）。可以直接粘贴文件夹路径：
                </p>
              )}

              {/* 无目录选择框时的降级入口；有选择框时也保留，作为"路径已知"时的快路径 */}
              <div className="flex items-center gap-2">
                <Input
                  className="h-8 flex-1 font-mono text-sm"
                  placeholder={hasFolderPicker ? '或粘贴文件夹路径' : 'C:/Users/Song/Documents/资料库'}
                  value={manualPath}
                  onChange={(e) => setManualPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addPath(manualPath)
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!manualPath.trim()}
                  onClick={() => void addPath(manualPath)}
                >
                  登记
                </Button>
              </div>
            </div>
          </div>
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
            desc={
              status?.semanticEnabled
                ? '换个说法试试，或直接用一整句话描述你要找的内容 —— 本机已开启语义检索，问句也能找到相关文档。也可能是这份资料还没被登记进来。'
                : '换个说法试试，或减少关键词 —— 多个词默认要求全部命中。也可能是这份资料还没被登记进来。'
            }
            actions={
              <Button variant="outline" size="sm" onClick={clearAll}>
                重新搜
              </Button>
            }
          />
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
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
                          className="max-w-[420px] truncate text-base font-medium hover:text-primary hover:underline"
                          title={hit.path}
                          onClick={() => void onOpen(hit)}
                        >
                          {hit.fileName}
                        </button>
                        <Badge variant="outline">{hit.fileType}</Badge>
                        {/* 只标「关键词之外的命中方式」：全站结果里 keyword 是基线，每条都挂一个反而是噪声 */}
                        {hit.matchedBy === 'semantic' && <Badge variant="secondary">语义命中</Badge>}
                        {hit.matchedBy === 'both' && <Badge>关键词 + 语义</Badge>}
                        {hit.matchCount > 1 && <Badge variant="secondary">命中 {hit.matchCount} 处</Badge>}
                        {hit.matchMode === 'or' && <Badge variant="warning">已放宽匹配</Badge>}
                        {hit.truncated && <Badge variant="outline">只索引了前半段</Badge>}
                      </div>

                      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
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
                              className="flex items-start gap-2.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-sm leading-relaxed"
                            >
                              <span className="w-7 shrink-0 select-none text-right font-mono text-xs text-muted-foreground/70">
                                {s.line}
                              </span>
                              <span className="min-w-0 flex-1 break-words">
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
                              {/* 一段话术一个按钮：命中段落才是能直接用的话，
                                  整份文件填进去没人要。 */}
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="shrink-0"
                                title="填进客服输入框（不会发送）"
                                disabled={fill.isPending}
                                onClick={() => onFill(s.text)}
                              >
                                <Icon name="arrowRight" size={14} />
                              </Button>
                            </div>
                          ))}
                          {hit.matchCount > hit.snippets.length && (
                            <div className="pl-10 text-xs text-muted-foreground">
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
      )}

      {/* ── 资料管理：索引范围 / 统计 / 已登记文件夹 ── */}
      {tab === 'manage' && (
        <>
          <div className="flex items-center gap-2 pt-1">
            <Icon name="database" size={14} className="text-muted-foreground" />
            <span className="text-base font-medium">索引范围</span>
            <span className="text-xs text-muted-foreground">支持 pdf / docx / xlsx / pptx / md / txt</span>
          </div>

          <motion.div
            variants={staggerList}
            initial="hidden"
            animate="show"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            <StatCard
              label="已索引文件"
              value={status?.fileCount ?? 0}
              icon="fileText"
              hint="命中一个文件只算一个，不按段落重复计"
            />
            <StatCard
              label="索引段落"
              value={status?.docCount ?? 0}
              icon="boxes"
              hint="正文按段落切开后的条数，决定搜索的粒度"
            />
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
              <div className="px-5 py-6 text-center text-sm text-muted-foreground">
                还没有登记文件夹。引擎只会扫描这里列出来的目录，不会碰其它地方。
              </div>
            ) : (
              <div className="divide-y divide-border">
                {folders.map((f) => (
                  <div key={f.path} className="flex items-center gap-3 px-5 py-3">
                    <Icon name="folder" size={15} className="shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-base font-medium" title={f.path}>
                          {f.name}
                        </span>
                        {f.docCount === 0 && <Badge variant="outline">暂无文档</Badge>}
                      </div>
                      <div className="truncate font-mono text-xs text-muted-foreground" title={f.path}>
                        {f.path}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">
                      {f.docCount} 段
                    </span>
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
        </>
      )}

      <ConfirmDialog
        open={!!pendingRemove}
        onOpenChange={(v) => !v && setPendingRemove(null)}
        action="delete"
        title={`注销「${pendingRemove?.name ?? ''}」？`}
        desc="会把它下面的文档从索引里撤回，之后的搜索不再命中这些文件。磁盘上的原文件不会被删除或修改。"
        confirmText="注销"
        pending={removeFolder.isPending}
        onConfirm={() => void doRemove()}
      >
        <div className="rounded-lg border border-border px-3 py-2 font-mono text-xs text-muted-foreground">
          {pendingRemove?.path}
        </div>
      </ConfirmDialog>
    </div>
  )
}
