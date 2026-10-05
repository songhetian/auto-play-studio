import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type SensitiveWord, type WordLevel } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/blocks/confirm-dialog'
import { Field } from '@/components/blocks/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { PageHeader } from '@/components/blocks/page-header'
import { EmptyState } from '@/components/blocks/empty-state'
import { RHYTHM } from '@/components/blocks/rhythm'
import { draftToWordInput } from '@/modules/sensitive/wordDraft'
import { ipc } from '@/lib/ipc'
import { Icon } from '@/components/icon'
import { cn } from '@/lib/utils'
import { toast } from '@/stores/toastStore'

/** 候选词的类型标签：让用户一眼看出这是手机号还是外链 */
const CAND_KIND_LABEL: Record<string, string> = {
  phone: '手机号',
  wechat: '微信号',
  qq: 'QQ',
  url: '外链',
}

const LEVEL_META: Record<WordLevel, { label: string; tone: 'destructive' | 'warning' | 'secondary' }> = {
  high: { label: '高危', tone: 'destructive' },
  mid: { label: '中危', tone: 'warning' },
  low: { label: '低危', tone: 'secondary' },
}

/**
 * 敏感词库。
 *
 * 词库是**全局共用**的（不是按实例各配一套）：合规规则对公司是统一的，
 * 复制到每个实例里改出分叉才是隐患 —— 用户改了一处，另一处还在按旧词跑。
 */
export default function SensitiveWordsPage() {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [level, setLevel] = useState<WordLevel | ''>('')
  const [draft, setDraft] = useState({ word: '', level: 'high' as WordLevel, matchKey: '', note: '' })
  const [editing, setEditing] = useState<SensitiveWord | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SensitiveWord | null>(null)
  const [note, setNote] = useState('')
  const [importText, setImportText] = useState('')
  const [showImport, setShowImport] = useState(false)
  /** 导入来源：粘贴文本 / JSON 文件 / 从运行应用采样 */
  const [srcTab, setSrcTab] = useState<'text' | 'json' | 'sample'>('text')
  const [jsonHot, setJsonHot] = useState(false)
  const [apps, setApps] = useState<{ hwnd: number; title: string }[]>([])
  const [appTitle, setAppTitle] = useState('')
  const [sampleText, setSampleText] = useState('')
  const [cands, setCands] = useState<{ kind: string; value: string; reason: string }[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const invalidate = () => qc.invalidateQueries({ queryKey: ['sensitive'] })

  const { data: list = [], isLoading } = useQuery({
    queryKey: ['sensitive', 'words', q, level],
    queryFn: () => api.listWords(q, level),
  })
  const { data: stats } = useQuery({ queryKey: ['sensitive', 'stats'], queryFn: api.wordStats })

  const add = useMutation({
    mutationFn: api.addWord,
    onSuccess: (w) => {
      invalidate()
      setDraft({ word: '', level: 'high', matchKey: '', note: '' })
      // 立刻告诉用户拼音键算成了什么：他下次就能验证"tkzc"能不能命中
      setNote(`已添加「${w.word}」${w.matchKey ? `，拼音键 ${w.matchKey}` : ''}`)
    },
    onError: (e) => setNote((e as Error).message),
  })
  const saveEdit = useMutation({
    mutationFn: (p: { id: number; word: string; level: WordLevel; match_key: string; note: string }) =>
      api.updateWord(p.id, p),
    onSuccess: (w) => {
      invalidate()
      setEditing(null)
      setNote(`已保存「${w.word}」${w.matchKey ? `，拼音键 ${w.matchKey}` : ''}`)
    },
    onError: (e) => setNote((e as Error).message),
  })
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => api.setWordEnabled(id, enabled),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: api.removeWord,
    onSuccess: () => {
      invalidate()
      setPendingDelete(null)
    },
  })
  const bulk = useMutation({
    mutationFn: api.importWords,
    onSuccess: (r) => {
      invalidate()
      setNote(
        `导入完成：成功 ${r.added.length} 条${r.skipped.length ? `，${r.skipped.length} 条未通过（${r.skipped.map((x) => `第${x.line}行 ${x.word}`).join('、')}）` : ''}`,
      )
      if (!r.skipped.length) {
        setImportText('')
        setShowImport(false)
      }
    },
    onError: (e) => setNote((e as Error).message),
  })

  /** JSON 导入：解析 → 调引擎 → 逐条报告失败 */
  const jsonImport = useMutation({
    mutationFn: api.importWordsJson,
    onSuccess: (r) => {
      invalidate()
      const msg = `JSON 导入完成：成功 ${r.added.length} 条${r.skipped.length ? `，${r.skipped.length} 条未通过（${r.skipped.map((x) => `第${x.line}项 ${x.word}`).join('、')}）` : ''}`
      setNote(msg)
      if (r.skipped.length) toast.info(msg)
      else toast.success(msg)
      if (!r.skipped.length) setShowImport(false)
    },
    onError: (e) => {
      setNote((e as Error).message)
      toast.error((e as Error).message)
    },
  })

  /** 从真实对话里提取候选词 */
  const candidates = useMutation({
    mutationFn: api.wordCandidates,
    onSuccess: (r) => {
      setCands(r.items)
      // 默认全选：这些是形态明确的联系方式，绝大多数情况都该进词库
      setPicked(new Set(r.items.map((_, i) => String(i))))
      if (!r.items.length) setNote('这段文本里没有找到手机号 / 微信 / QQ / 外链这类联系方式')
    },
    onError: (e) => setNote((e as Error).message),
  })

  /** 勾选的候选批量入库（走后端 JSON 导入，一次请求） */
  const addCandidates = useMutation({
    mutationFn: (rows: { word: string; level: string; note: string }[]) =>
      api.importWordsJson(rows.map((r) => ({ ...r, level: r.level }))),
    onSuccess: (r) => {
      invalidate()
      setCands([])
      setSampleText('')
      setPicked(new Set())
      setNote(`已加入 ${r.added.length} 条${r.skipped.length ? `，${r.skipped.length} 条未通过` : ''}`)
    },
    onError: (e) => setNote((e as Error).message),
  })

  /** 读 JSON 文件并直接导入 */
  const readJsonFile = async (f: File) => {
    try {
      const parsed = JSON.parse(await f.text())
      // 顶层是 {words:[...]} 时取内层；否则整个文件当数组用
      const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'words' in parsed
        ? (parsed as { words: unknown }).words
        : parsed
      if (!Array.isArray(payload)) {
        setNote('JSON 顶层应当是数组，或包含 words 数组的对象')
        return
      }
      jsonImport.mutate(payload)
    } catch (e) {
      setNote(`JSON 解析失败：${(e as Error).message}`)
    }
  }

  /** 导出成 studio 的 wordlib.json：别人在 Studio 里改完再导入回来，形成编辑闭环 */
  const exportJson = async () => {
    try {
      const data = await api.exportWordsJson()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `wordlib-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      setNote('已导出 wordlib.json（studio 格式）：可发给同事在 Studio 里编辑，再导入回来')
      toast.success('已导出 wordlib.json')
    } catch (e) {
      setNote((e as Error).message)
      toast.error((e as Error).message)
    }
  }

  /** 文件选择器：直接读文件内容并导入，闭环「选择文件」路径
   * （之前只拿到路径、提示用户去粘贴 —— 那是个没真正完成导入的洞） */
  const fileInputRef = useRef<HTMLInputElement>(null)
  const onSelectFile = (f: File | undefined) => {
    if (f) void readJsonFile(f)
  }

  /* ── wordlib.json 自动同步：主管分发同一个文件，坐席端不必每次手动导入 ──
   * 监听在引擎后台线程里跑，结果不会主动推给前端，所以面板打开时定期刷新状态。 */
  const { data: watch } = useQuery({
    queryKey: ['sensitive', 'wordlib-watch'],
    queryFn: api.getWordlibWatch,
    refetchInterval: showImport && srcTab === 'json' ? 5000 : false,
  })

  const setWatch = useMutation({
    mutationFn: api.setWordlibWatch,
    onSuccess: (st) => {
      invalidate()
      if (!st.path) {
        toast.info('已关闭自动同步')
        return
      }
      const n = st.lastResult?.added?.length ?? 0
      toast.success(st.lastImportAt ? `已开启自动同步，本次导入 ${n} 条` : '已开启自动同步')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const pickWatchFile = async () => {
    const path = await ipc.selectFile({ accept: 'json' })
    if (!path) return // 用户取消
    setWatch.mutate(path)
  }

  /** 打开「采样」时列一次窗口；枚举不到就留空，界面会明确说明 */
  useEffect(() => {
    if (!showImport || srcTab !== 'sample' || apps.length > 0) return
    void api
      .sensitiveApps()
      .then((list) => {
        setApps(list)
        if (list.length) setAppTitle((t) => t || list[0].title)
      })
      .catch(() => setApps([]))
    // 只在打开采样页时拉一次：窗口列表会变，但用户切走再回来时刷新即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showImport, srcTab])

  /** 词库是否为空：空库时「建监控实例」毫无意义，得先提示配词 */
  const empty = !isLoading && list.length === 0 && !q && !level

  const counts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const w of list) m[w.level] = (m[w.level] ?? 0) + 1
    return m
  }, [list])

  return (
    <div className={RHYTHM.pageShell}>
      <PageHeader
        icon="shield"
        title="敏感词库"
        desc="一套全局共用的违禁词。敏感词监控实例盯住聊天输入框，客服打出这里的词就立即弹窗提醒"
        actions={
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void exportJson()}>
              <Icon name="download" size={14} />
              导出 JSON
            </Button>
            <Button size="sm" onClick={() => setShowImport((v) => !v)}>
              <Icon name="upload" size={14} />
              批量导入
            </Button>
          </div>
        }
      />

      {/* ── 添加单词 ── */}
      <Card>
        <CardHeader>
          <CardTitle>添加违禁词</CardTitle>
          <Badge variant="secondary">{stats ? `共 ${stats.total} 条 / 启用 ${stats.enabled}` : '…'}</Badge>
        </CardHeader>
        <CardContent className={RHYTHM.sectionStack}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px_1fr]">
            <Field label="违禁词" required>
              <Input
                value={draft.word}
                placeholder="如 加微信 / 退款政策 / 最便宜"
                onChange={(e) => setDraft({ ...draft, word: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && draft.word.trim()) add.mutate(draftToWordInput(draft))
                }}
              />
            </Field>
            <Field label="危级" hint="高危会响铃">
              <select
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-base"
                value={draft.level}
                onChange={(e) => setDraft({ ...draft, level: e.target.value as WordLevel })}
              >
                <option value="high">高危</option>
                <option value="mid">中危</option>
                <option value="low">低危</option>
              </select>
            </Field>
            <Field label="拼音键" hint="留空自动算">
              <Input
                value={draft.matchKey}
                placeholder="自动（tkzc）"
                onChange={(e) => setDraft({ ...draft, matchKey: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!draft.word.trim() || add.isPending} onClick={() => add.mutate(draftToWordInput(draft))}>
              <Icon name="plus" size={13} />
              添加
            </Button>
            <span className="text-sm text-muted-foreground">
              拼音键会自动算好，客服只记得「tkzc」这类缩写也能命中
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── 导入：三种来源 ── */}
      {showImport && (
        <Card>
          <CardHeader>
            <CardTitle>批量导入</CardTitle>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ['text', '粘贴文本'],
                  ['json', 'JSON 文件'],
                  ['sample', '从运行应用采样'],
                ] as const
              ).map(([k, label]) => (
                <Button
                  key={k}
                  size="sm"
                  variant={srcTab === k ? 'default' : 'outline'}
                  onClick={() => setSrcTab(k)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className={RHYTHM.sectionStack}>
            {/* ① 粘贴文本 */}
            {srcTab === 'text' && (
              <>
                <Textarea
                  rows={7}
                  value={importText}
                  placeholder={'退款政策,high\n最,low\n加微信\n（留空行与 # 开头的行会被跳过；逗号后写危级）'}
                  onChange={(e) => setImportText(e.target.value)}
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={!importText.trim() || bulk.isPending}
                    onClick={() => bulk.mutate(importText)}
                  >
                    导入
                  </Button>
                  <span className="text-sm text-muted-foreground">失败的行会逐条告诉你，不会静默丢掉</span>
                </div>
              </>
            )}

            {/* ② JSON 文件：拖进来或点选 */}
            {srcTab === 'json' && (
              <>
                <div
                  onDragOver={(e) => {
                    e.preventDefault()
                    setJsonHot(true)
                  }}
                  onDragLeave={() => setJsonHot(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setJsonHot(false)
                    const f = e.dataTransfer.files?.[0]
                    if (f) void readJsonFile(f)
                  }}
                  className={cn(
                    'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors',
                    jsonHot ? 'border-primary bg-primary/[0.06]' : 'border-border bg-muted/30',
                  )}
                >
                  <Icon name="upload" size={20} className="text-muted-foreground" />
                  <div className="text-base">把 .json 文件拖到这里</div>
                  <div className="max-w-[520px] text-xs leading-relaxed text-muted-foreground">
                    两种结构都收：<code className="font-mono">{ '["加微信", "私下交易"]' }</code> 或
                    <code className="font-mono">{ '[{"word":"退款政策","level":"mid"}]' }</code>
                  </div>
                  <Button variant="outline" size="sm" disabled={jsonImport.isPending} onClick={() => fileInputRef.current?.click()}>
                    选择文件…
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(e) => {
                      onSelectFile(e.target.files?.[0])
                      e.target.value = '' // 清空：连续选同一文件也能再次触发
                    }}
                  />
                </div>

                {/* 自动同步：主管分发同一个文件，之后它一变就自动导入（单向，不回写文件） */}
                <div className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-base">自动同步这个文件</div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {watch?.path
                          ? watch.path
                          : '选一个 wordlib.json；之后它一变就自动导入（只读文件，不改变它）'}
                      </div>
                    </div>
                    <div className="flex flex-none items-center gap-1.5">
                      <Button variant="outline" size="sm" disabled={setWatch.isPending} onClick={() => void pickWatchFile()}>
                        选择文件…
                      </Button>
                      {watch?.path && (
                        <Button variant="ghost" size="sm" disabled={setWatch.isPending} onClick={() => setWatch.mutate('')}>
                          关闭
                        </Button>
                      )}
                    </div>
                  </div>
                  {watch?.lastError ? (
                    <div className="mt-2 text-xs text-destructive">{watch.lastError}</div>
                  ) : watch?.lastImportAt ? (
                    <div className="mt-2 text-xs text-muted-foreground">
                      上次自动导入：{watch.lastImportAt}（新增 {watch.lastResult?.added?.length ?? 0} 条）
                    </div>
                  ) : null}
                </div>
              </>
            )}

            {/* ③ 从运行中的应用采样：用户最真实的痛点是「不知道该禁什么」 */}
            {srcTab === 'sample' && (
              <>
                {apps.length > 0 ? (
                  <Field label="选一个在用的应用" hint="从它的窗口里取一段文本，工具帮你挑出形似联系方式的候选">
                    <select
                      className="h-8 w-full rounded-md border border-input bg-background px-2 text-base"
                      value={appTitle}
                      onChange={(e) => {
                        setAppTitle(e.target.value)
                        setCands([])
                      }}
                    >
                      {apps.map((a) => (
                        <option key={a.hwnd} value={a.title}>
                          {a.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">
                    当前环境枚举不到窗口（桌面版会自动列出）。你也可以直接把一段真实对话粘到下面。
                  </div>
                )}

                <Field label="或直接粘贴一段真实对话" hint="工具只挑出手机号 / 微信 / QQ / 外链这类有明确形态的，不会乱猜">
                  <Textarea
                    rows={5}
                    value={sampleText}
                    placeholder={'亲，加个微信 abc123456 详聊\n电话 13800138000'}
                    onChange={(e) => {
                      setSampleText(e.target.value)
                      setCands([])
                    }}
                  />
                </Field>

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={!sampleText.trim() || candidates.isPending}
                    onClick={() => candidates.mutate(sampleText)}
                  >
                    提取候选词
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    提取结果由你勾选决定 —— 工具不替你做决定
                  </span>
                </div>

                {cands.length > 0 && (
                  <div className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">
                        找到 {cands.length} 个候选
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setPicked(new Set(cands.map((_, i) => String(i))))}
                        >
                          全选
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setPicked(new Set())}>
                          清空
                        </Button>
                      </div>
                    </div>
                    <div className="max-h-[240px] space-y-1 overflow-y-auto">
                      {cands.map((c, i) => {
                        const on = picked.has(String(i))
                        return (
                          <button
                            key={`${c.kind}-${c.value}-${i}`}
                            type="button"
                            onClick={() => {
                              const next = new Set(picked)
                              if (on) next.delete(String(i))
                              else next.add(String(i))
                              setPicked(next)
                            }}
                            className={cn(
                              'flex w-full items-start gap-2.5 rounded-md border p-2 text-left transition-colors',
                              on ? 'border-primary bg-primary/[0.05]' : 'border-border hover:bg-accent/40',
                            )}
                          >
                            <span
                              className={cn(
                                'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border',
                                on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50',
                              )}
                            >
                              {on && <Icon name="check" size={11} />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2">
                                <span className="font-mono text-sm">{c.value}</span>
                                <Badge variant="secondary">{CAND_KIND_LABEL[c.kind] ?? c.kind}</Badge>
                              </span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">{c.reason}</span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                    <Button
                      size="sm"
                      disabled={picked.size === 0 || addCandidates.isPending}
                      onClick={() =>
                        addCandidates.mutate(
                          cands.filter((_, i) => picked.has(String(i))).map((c) => ({
                            word: c.value,
                            level: c.kind === 'phone' || c.kind === 'wechat' ? ('high' as const) : ('mid' as const),
                            note: `采样自「${appTitle || '粘贴的对话'}」`,
                          })),
                        )
                      }
                    >
                      把勾选的 {picked.size} 个加入词库
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── 搜索与筛选 ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Icon name="search" size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8"
            placeholder="搜词、拼音键或备注…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索违禁词"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant={level === '' ? 'default' : 'outline'} size="sm" onClick={() => setLevel('')}>
            全部 {stats ? stats.total : ''}
          </Button>
          {(['high', 'mid', 'low'] as const).map((k) => (
            <Button key={k} variant={level === k ? 'default' : 'outline'} size="sm" onClick={() => setLevel(k)}>
              {LEVEL_META[k].label} {counts[k] ?? 0}
            </Button>
          ))}
        </div>
      </div>

      {note && (
        <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">{note}</div>
      )}

      {/* ── 列表 ── */}
      {empty ? (
        <EmptyState
          icon="shield"
          title="词库还是空的"
          desc="敏感词监控靠这份词表工作。先加几个词，或用批量导入一次性贴几百个进来。开始建议只配「高危」，用顺手了再放开中低危。"
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="divide-y divide-border">
            {list.map((w) => (
              <div key={w.id} className={cn('flex items-center gap-3 px-5 py-3', !w.enabled && 'opacity-60')}>
                <div className="min-w-0 flex-1">
                  {editing?.id === w.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        className="h-7 w-40"
                        value={editing.word}
                        onChange={(e) => setEditing({ ...editing, word: e.target.value })}
                      />
                      <select
                        className="h-7 rounded-md border border-input bg-background px-2 text-sm"
                        value={editing.level}
                        onChange={(e) => setEditing({ ...editing, level: e.target.value as WordLevel })}
                      >
                        <option value="high">高危</option>
                        <option value="mid">中危</option>
                        <option value="low">低危</option>
                      </select>
                      <Input
                        className="h-7 w-32"
                        value={editing.matchKey}
                        placeholder="拼音键"
                        onChange={(e) => setEditing({ ...editing, matchKey: e.target.value })}
                      />
                      <Input
                        className="h-7 flex-1 min-w-[120px]"
                        value={editing.note}
                        placeholder="备注"
                        onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                      />
                      <Button
                        size="sm"
                        disabled={!editing.word.trim() || saveEdit.isPending}
                        onClick={() =>
                          saveEdit.mutate({
                            id: editing.id,
                            word: editing.word.trim(),
                            level: editing.level,
                            match_key: editing.matchKey,
                            note: editing.note,
                          })
                        }
                      >
                        保存
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                        取消
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-medium">{w.word}</span>
                      <Badge variant={LEVEL_META[w.level].tone}>{LEVEL_META[w.level].label}</Badge>
                      {w.matchKey && <span className="font-mono text-xs text-muted-foreground">{w.matchKey}</span>}
                      {w.note && <span className="text-xs text-muted-foreground">{w.note}</span>}
                      {w.hitCount > 0 && (
                        <span className="text-xs text-muted-foreground">命中 {w.hitCount} 次</span>
                      )}
                      {!w.enabled && <Badge variant="outline">已停用</Badge>}
                    </div>
                  )}
                </div>

                {editing?.id !== w.id && (
                  <div className="flex shrink-0 items-center gap-1">
                    <div className="flex items-center gap-1.5 pr-1">
                      <span className="text-xs text-muted-foreground">{w.enabled ? '启用' : '停用'}</span>
                      <Switch
                        checked={w.enabled}
                        disabled={toggle.isPending}
                        onCheckedChange={(v) => toggle.mutate({ id: w.id, enabled: v })}
                        aria-label={`${w.word} 启用状态`}
                      />
                    </div>
                    <Button variant="ghost" size="icon-sm" title="编辑" onClick={() => setEditing(w)}>
                      <Icon name="sliders" size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="删除"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setPendingDelete(w)}
                    >
                      <Icon name="trash" size={13} />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(v) => !v && setPendingDelete(null)}
        action="delete"
        title={`删除违禁词「${pendingDelete?.word ?? ''}」？`}
        desc="删除后不再参与监控匹配。历史命中记录会保留。"
        confirmText="删除"
        pending={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
      />
    </div>
  )
}