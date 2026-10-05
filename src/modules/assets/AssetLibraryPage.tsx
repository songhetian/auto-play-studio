import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { AssetInUseError, api } from '@/lib/api'
import type { AssetRef, ImageAsset } from '@/lib/api'
import { ALL_TAGS, filterAssets, groupProblems, tagsOf } from '@/lib/assetFilter'
import { hasRegionPicker, ipc } from '@/lib/ipc'
import { IMAGE_EXT, VIDEO_EXT } from '@/lib/fileDrop'
import { buildSynonymMap, locateByIntent } from '@/lib/intentLocate'
import { downloadGroups, readGroupsFile } from '@/lib/synonymIo'
import { cn } from '@/lib/utils'
import { useSynonymStore } from '@/stores/synonymStore'
import { toast } from '@/stores/toastStore'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Icon } from '@/components/icon'
import { ConfirmDialog } from '@/components/blocks/confirm-dialog'
import { EmptyState } from '@/components/blocks/empty-state'
import { AssetDetailDialog } from '@/components/blocks/image-lightbox'
import { PageHeader } from '@/components/blocks/page-header'
import {
  useAssetAudit,
  useAssets,
  useCaptureAsset,
  useDeleteAsset,
  useExtractVideo,
  useUpdateAsset,
  useUploadAsset,
} from '@/modules/assets/useAssets'
import { fadeItem, staggerList } from '@/lib/motion'

/**
 * 素材库：图像素材的唯一真理源，RPA 实例的图像指令都从这里选图。
 *
 * 页面的组织顺序跟着「我会遇到什么问题」走：
 *   有问题 → 先说问题；要找图 → 搜索与标签；要看图 → 格子（图才是主体）；
 *   要改名/改阈值 → 点开详情弹窗；要删 → 先问「谁在用」。
 */
export default function AssetLibraryPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [kw, setKw] = useState('')
  const [tag, setTag] = useState(ALL_TAGS)
  const [note, setNote] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** 被引用、等待用户确认强删的素材 */
  const [blocked, setBlocked] = useState<{ asset: ImageAsset; message: string; refs: AssetRef[] } | null>(null)

  const { data: assets = [], isLoading } = useAssets()
  const { data: problems = [] } = useAssetAudit()
  const upload = useUploadAsset()
  const extractVideo = useExtractVideo()
  const capture = useCaptureAsset()
  const update = useUpdateAsset()
  const remove = useDeleteAsset()

  /** 意图定位：输入一句自然语言（"检查是否遗漏配件"），按名字/标签/OCR 快速定位相关素材 */
  const [intent, setIntent] = useState('')

  // 可自定义同义词表：从持久化 store 读，喂给意图定位；改词即时生效、跨会话记住
  const { groups, addGroup, removeGroup, addWord, removeWord, reset, setGroups } = useSynonymStore()
  const synonymMap = useMemo(() => buildSynonymMap(groups), [groups])
  const [synOpen, setSynOpen] = useState(false)

  // 同义词表跨机器分享：导出成一个 JSON 文件发出去；导入用文件覆盖当前表
  const handleExportSynonyms = () => {
    try {
      downloadGroups(groups)
      setNote('已导出 synonyms.json：可发给同事，对方在「同义词管理」里导入即可')
      toast.success('已导出 synonyms.json')
    } catch (e) {
      setNote((e as Error).message)
      toast.error((e as Error).message)
    }
  }
  const handleImportSynonyms = async () => {
    try {
      const parsed = await readGroupsFile()
      if (!parsed) return // 用户取消选择
      setGroups(parsed)
      setNote(`已从文件导入 ${parsed.length} 个同义词组`)
      toast.success(`已导入 ${parsed.length} 个同义词组`)
    } catch (e) {
      setNote(`导入失败：${(e as Error).message}`)
      toast.error(`导入失败：${(e as Error).message}`)
    }
  }

  const problemsByAsset = useMemo(() => groupProblems(problems), [problems])
  const shown = useMemo(() => filterAssets(assets, { keyword: kw, tag }), [assets, kw, tag])
  const brokenCount = new Set(problems.map((p) => p.assetId)).size

  // 意图定位：把素材（名字/标签）当可检索文本，按意图句关键词打分排序；离线启发式（见 docs）
  const intentHits = useMemo(() => {
    if (!intent.trim()) return null
    const hits = locateByIntent(
      intent,
      shown.map((a) => ({ id: a.id, name: a.name, tag: a.tag })),
      synonymMap,
    )
    return hits.length ? hits : null
    // synonymMap 必须进依赖：同义词弹窗改了词表后，intent/shown 没变也要重算，
    // 否则界面仍用旧同义词表（文案却承诺「改动即时生效」）
  }, [intent, shown, synonymMap])

  const hitIds = useMemo(() => new Set(intentHits?.map((h) => h.id) ?? []), [intentHits])

  // 命中意图的素材排到最前，方便"不用从头翻"
  const ranked = useMemo(() => {
    if (!intentHits) return shown
    const order = new Map(intentHits.map((h, i) => [h.id, i]))
    return [...shown].sort((a, b) => {
      const ia = order.has(a.id) ? (order.get(a.id) as number) : Number.MAX_SAFE_INTEGER
      const ib = order.has(b.id) ? (order.get(b.id) as number) : Number.MAX_SAFE_INTEGER
      return ia - ib
    })
  }, [intentHits, shown])

  // 选中项从查询结果里取，保证改名/改阈值后弹窗内容跟着刷新
  const selected = useMemo(() => assets.find((a) => a.id === selectedId) ?? null, [assets, selectedId])
  const tags = useMemo(() => tagsOf(assets), [assets])

  const doDelete = async (asset: ImageAsset, force: boolean) => {
    setNote('')
    try {
      const r = await remove.mutateAsync({ id: asset.id, force })
      setBlocked(null)
      setSelectedId(null)
      setNote(force && r.clearedRefs ? `已删除，并清空了 ${r.clearedRefs} 处指令里的引用` : '已删除')
    } catch (e) {
      if (e instanceof AssetInUseError) {
        setBlocked({ asset, message: e.message, refs: e.refs })
        return
      }
      setNote((e as Error).message)
    }
  }

  const onUpload = async (files: File[] | FileList | null) => {
    setNote('')
    const list = Array.from(files ?? [])
    if (!list.length) return
    const isVideo = (f: File) => VIDEO_EXT.split(',').some((ext) => f.name.toLowerCase().endsWith(ext))
    const videos = list.filter(isVideo)
    const images = list.filter((f) => !isVideo(f))
    try {
      let imgCount = 0
      for (const file of images) {
        await upload.mutateAsync({ file })
        imgCount += 1
      }
      // 视频：均匀抽帧成素材，免得让人从头翻一遍找目标画面
      let frameCount = 0
      for (const file of videos) {
        const r = await extractVideo.mutateAsync(file)
        frameCount += r.count
      }
      if (imgCount) {
        setNote(`已导入 ${imgCount} 张图片${videos.length ? `，并从 ${videos.length} 段视频抽出 ${frameCount} 帧（标签「视频帧」）` : ''}`)
      } else if (videos.length) {
        setNote(`已从 ${videos.length} 段视频抽出 ${frameCount} 帧，进素材库后可用「意图定位」快速找目标画面`)
      }
    } catch (e) {
      setNote((e as Error).message)
    }
  }

  const onCapture = async () => {
    setNote('')
    const region = await ipc.selectRegion()
    if (!region) return
    try {
      const a = await capture.mutateAsync(region)
      setSelectedId(a.id)
      setNote('已截取并存入素材库，可以改个名字再关掉')
    } catch (e) {
      setNote((e as Error).message)
    }
  }

  // 页面级拖拽热区：素材图多半是一批拖进来的，在正文任意位置松手都能收。
  // 拖到别处（顶部导航、侧边栏）不响应，避免"界面到处都在接文件"。
  const [pageDrag, setPageDrag] = useState(false)
  const dragDepth = useRef(0)
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      dragDepth.current += 1
      setPageDrag(true)
    }
    const onLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setPageDrag(false)
    }
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setPageDrag(false)
      void onUpload(e.dataTransfer?.files ?? null)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
    // onUpload 每次渲染都是新函数；这里只注册一次，靠 ref 取最新实现
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className={cn(
        'mx-auto max-w-[1240px] space-y-5 p-5 transition-colors',
        pageDrag && 'relative rounded-lg ring-2 ring-primary/40',
      )}
    >
      {pageDrag && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-background/85">
          <div className="flex flex-col items-center gap-2 text-center">
            <Icon name="download" size={26} className="text-primary" />
            <div className="text-base font-medium">松手就把图片放进素材库</div>
            <div className="text-xs text-muted-foreground">支持 {IMAGE_EXT.split(',').join(' / ')} 与视频抽帧，可一次多选</div>
          </div>
        </div>
      )}
      <PageHeader
        icon="assets"
        title="图像素材库"
        desc="每个实例的图像指令都指向这里的素材；点开任意一张可以看大图、改名字与调阈值"
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept={`${IMAGE_EXT},${VIDEO_EXT}`}
              multiple
              className="hidden"
              onChange={(e) => {
                void onUpload(e.target.files)
                e.target.value = ''
              }}
            />
            <Button variant="outline" size="sm" disabled={upload.isPending} onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={14} />
              导入图片（可多选）
            </Button>
            <Button
              size="sm"
              disabled={capture.isPending}
              title={hasRegionPicker ? '拉一块全屏遮罩，拖拽框选' : '框选截图需要在桌面端（Electron）中运行'}
              onClick={() => void onCapture()}
            >
              <Icon name="crop" size={14} />
              框选截图
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSynOpen(true)}>
              <Icon name="tag" size={14} />
              同义词（{groups.length}）
            </Button>
          </>
        }
      />

      {note && (
        <Alert variant="info">
          <Icon name="info" size={16} />
          <AlertDescription className="flex items-center gap-3">
            <span>{note}</span>
            <Button variant="ghost" size="sm" className="ml-auto h-6" onClick={() => setNote('')}>
              <Icon name="close" size={12} />
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!hasRegionPicker && (
        <Alert>
          <Icon name="info" size={16} />
          <AlertDescription>框选截图需要桌面端；浏览器预览里请用「导入图片」。</AlertDescription>
        </Alert>
      )}

      {!!problems.length && (
        <Alert variant="warning">
          <Icon name="warning" size={16} />
          <AlertDescription>
            <div className="font-medium">体检发现 {problems.length} 处问题</div>
            <ul className="mt-1 space-y-0.5">
              {problems.slice(0, 6).map((p, i) => (
                <li key={i}>
                  {p.instanceName} 的第 {p.cmdIndex + 1} 条指令「{p.cmdName}」：{p.detail}
                </li>
              ))}
            </ul>
            {problems.length > 6 && <div className="mt-1">…等 {problems.length} 处</div>}
          </AlertDescription>
        </Alert>
      )}

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon name="assets" size={14} className="text-muted-foreground" />
            素材
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{assets.length} 张</Badge>
            {brokenCount > 0 && <Badge variant="destructive">{brokenCount} 张有问题</Badge>}
          </div>
        </CardHeader>

        <div className="space-y-2 border-b border-border p-3">
          <div className="relative">
            <Icon
              name="target"
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className="pl-8"
              placeholder="输入意图快速定位，如：检查是否遗漏配件"
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
            />
            {intent && (
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 h-6 -translate-y-1/2"
                onClick={() => setIntent('')}
              >
                <Icon name="close" size={12} />
              </Button>
            )}
          </div>
          {intentHits && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Icon name="target" size={13} className="text-primary" />
              按意图「{intent}」找到 <span className="font-medium text-foreground">{hitIds.size}</span> 张，已排到最前
            </div>
          )}
        </div>

        <Dialog open={synOpen} onOpenChange={setSynOpen}>
          <DialogContent className="sm:max-w-[560px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Icon name="tag" size={15} />
                同义词管理
              </DialogTitle>
              <DialogDescription>
                同组词互为等价：输入「螺丝」也能定位名为「螺栓」「螺钉」的素材。改动即时生效，并跨会话记住。
                导出成 JSON 可发给同事；导入会用文件覆盖当前同义词表。
              </DialogDescription>
            </DialogHeader>

            <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
              {groups.map((group, gi) => (
                <div key={gi} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">同义词组 {gi + 1}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-muted-foreground"
                      onClick={() => removeGroup(gi)}
                    >
                      <Icon name="trash" size={13} />
                      删组
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.map((w) => (
                      <span
                        key={w}
                        className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-sm"
                      >
                        {w}
                        <button
                          type="button"
                          aria-label={`删除同义词 ${w}`}
                          className="text-muted-foreground transition-colors hover:text-destructive"
                          onClick={() => removeWord(gi, w)}
                        >
                          <Icon name="close" size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                  <form
                    className="mt-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      const v = new FormData(e.currentTarget).get('w') as string
                      if (v?.trim()) {
                        addWord(gi, v.trim())
                        e.currentTarget.reset()
                      }
                    }}
                  >
                    <Input name="w" className="h-7 text-sm" placeholder="加一个同义词，回车确认" />
                  </form>
                </div>
              ))}
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" onClick={handleExportSynonyms}>
                <Icon name="download" size={13} />
                导出 JSON
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleImportSynonyms()}>
                <Icon name="upload" size={13} />
                导入 JSON
              </Button>
              <Button variant="outline" size="sm" onClick={() => addGroup()}>
                <Icon name="plus" size={13} />
                新增同义词组
              </Button>
              <Button variant="ghost" size="sm" onClick={() => reset()}>
                恢复内置默认
              </Button>
              <Button size="sm" onClick={() => setSynOpen(false)}>
                完成
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative w-[220px]">
            <Icon
              name="search"
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input className="pl-8" placeholder="搜索素材名…" value={kw} onChange={(e) => setKw(e.target.value)} />
          </div>
          <Select value={tag} onValueChange={setTag}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[ALL_TAGS, ...tags].map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Badge variant="secondary">{shown.length} 个结果</Badge>
          {(kw || tag !== ALL_TAGS) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setKw('')
                setTag(ALL_TAGS)
              }}
            >
              <Icon name="close" size={13} />
              清除筛选
            </Button>
          )}
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="h-[152px] animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : !shown.length ? (
          <EmptyState
            icon={assets.length ? 'search' : 'assets'}
            title={assets.length ? '没有匹配的素材' : '素材库还是空的'}
            desc={
              assets.length
                ? '换个关键词，或把标签切回「全部」。'
                : '监控类工具需要一张「目标图」才能工作，先导入一张，或用框选截图现场截一块。'
            }
            actions={
              assets.length ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setKw('')
                    setTag(ALL_TAGS)
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={() => fileRef.current?.click()}>
                    <Icon name="upload" size={13} />
                    导入图片
                  </Button>
                  {hasRegionPicker && (
                    <Button variant="outline" size="sm" onClick={() => void onCapture()}>
                      <Icon name="crop" size={13} />
                      框选截图
                    </Button>
                  )}
                </>
              )
            }
          />
        ) : (
          <motion.div
            variants={staggerList}
            initial="hidden"
            animate="show"
            className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 lg:grid-cols-5"
          >
            {ranked.map((a) => {
              const bad = problemsByAsset[a.id] ?? []
              return (
                <motion.button
                  key={a.id}
                  variants={fadeItem}
                  whileHover={{ y: -2 }}
                  onClick={() => setSelectedId(a.id)}
                  className={cn(
                    'group overflow-hidden rounded-xl border border-border bg-card text-left shadow-sm transition-colors hover:border-primary/50',
                    hitIds.has(a.id) && 'ring-2 ring-primary',
                  )}
                >
                  <div
                    className="relative flex h-[92px] items-center justify-center border-b border-border p-2"
                    style={{
                      backgroundImage:
                        'linear-gradient(45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--muted)) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--muted)) 75%)',
                      backgroundSize: '14px 14px',
                      backgroundPosition: '0 0, 0 7px, 7px -7px, -7px 0',
                    }}
                  >
                    <img src={api.imageRawUrl(a.id)} alt={a.name} className="max-h-full max-w-full object-contain" />
                    <span className="absolute inset-0 flex items-center justify-center gap-1.5 bg-background/70 text-sm font-medium opacity-0 backdrop-blur-[2px] transition-opacity group-hover:opacity-100">
                      <Icon name="eye" size={14} />
                      查看
                    </span>
                    {!!bad.length && (
                      <span className="absolute right-1.5 top-1.5">
                        <Badge variant="destructive">
                          {bad[0].kind === 'missing_file' ? '文件丢失' : '素材缺失'}
                        </Badge>
                      </span>
                    )}
                  </div>

                  <div className="space-y-1.5 p-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium" title={a.name}>
                        {a.name}
                      </span>
                      <Icon name="pencil" size={11} className="ml-auto shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-2xs text-muted-foreground">
                      <span>
                        {a.width}×{a.height}
                      </span>
                      <span className="text-muted-foreground/50">|</span>
                      <span>{a.threshold.toFixed(2)}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {a.tag && a.tag !== ALL_TAGS && <Badge variant="outline">{a.tag}</Badge>}
                      {a.refCount > 0 && <Badge variant="default">用 {a.refCount} 处</Badge>}
                    </div>
                  </div>
                </motion.button>
              )
            })}
          </motion.div>
        )}
      </Card>

      <AssetDetailDialog
        asset={selected}
        list={shown}
        existingTags={tags}
        onSelect={(a) => setSelectedId(a.id)}
        onClose={() => setSelectedId(null)}
        onUpdate={(patch) => selected && update.mutate({ id: selected.id, patch })}
        onDelete={(a) => void doDelete(a, false)}
        saving={update.isPending}
        refs={
          selected
            ? (problemsByAsset[selected.id] ?? []).map((p) => ({
                instanceName: p.instanceName,
                cmdIndex: p.cmdIndex,
                cmdName: p.cmdName,
              }))
            : undefined
        }
      />

      <ConfirmDialog
        open={!!blocked}
        onOpenChange={(v) => !v && setBlocked(null)}
        icon="warning"
        tone="warn"
        title="这张图正在被使用"
        desc={blocked?.message}
        confirmText="强制删除"
        pending={remove.isPending}
        onConfirm={() => blocked && void doDelete(blocked.asset, true)}
      >
        <div className="max-h-[200px] space-y-0 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {blocked?.refs.map((r, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
              <Icon name="link" size={13} className="shrink-0 text-muted-foreground" />
              <span className="font-medium">{r.instanceName}</span>
              <span className="text-muted-foreground">
                第 {r.cmdIndex + 1} 条指令「{r.cmdName}」
              </span>
            </div>
          ))}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          强制删除会把上面这些指令里的引用一并清空，那些指令需要重新选图。
        </p>
      </ConfirmDialog>
    </div>
  )
}
