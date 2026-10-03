import { useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { AssetInUseError, api } from '@/lib/api'
import type { AssetRef, ImageAsset } from '@/lib/api'
import { ALL_TAGS, filterAssets, groupProblems, tagsOf } from '@/lib/assetFilter'
import { hasRegionPicker, ipc } from '@/lib/ipc'
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
  const capture = useCaptureAsset()
  const update = useUpdateAsset()
  const remove = useDeleteAsset()

  const problemsByAsset = useMemo(() => groupProblems(problems), [problems])
  const shown = useMemo(() => filterAssets(assets, { keyword: kw, tag }), [assets, kw, tag])
  const brokenCount = new Set(problems.map((p) => p.assetId)).size

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

  const onUpload = async (files: FileList | null) => {
    setNote('')
    const list = Array.from(files ?? [])
    if (!list.length) return
    try {
      const created: ImageAsset[] = []
      for (const file of list) created.push(await upload.mutateAsync({ file }))
      // 单张导入时直接把详情弹窗打开：用户几乎总想给它改个名字
      if (created.length === 1) setSelectedId(created[0].id)
      setNote(`已导入 ${created.length} 张${created.length === 1 ? '，可以直接改名字' : ''}`)
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

  return (
    <div className="mx-auto max-w-[1240px] space-y-4 p-5">
      <PageHeader
        icon="assets"
        title="图像素材库"
        desc="每个实例的图像指令都指向这里的素材；点开任意一张可以看大图、改名字与调阈值"
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/bmp,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                void onUpload(e.target.files)
                e.target.value = ''
              }}
            />
            <Button variant="outline" size="sm" disabled={upload.isPending} onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={14} />
              导入图片
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
            {shown.map((a) => {
              const bad = problemsByAsset[a.id] ?? []
              return (
                <motion.button
                  key={a.id}
                  variants={fadeItem}
                  whileHover={{ y: -2 }}
                  onClick={() => setSelectedId(a.id)}
                  className="group overflow-hidden rounded-xl border border-border bg-card text-left shadow-sm transition-colors hover:border-primary/50"
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
                    <span className="absolute inset-0 flex items-center justify-center gap-1.5 bg-background/70 text-[12px] font-medium opacity-0 backdrop-blur-[2px] transition-opacity group-hover:opacity-100">
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
                      <span className="truncate text-[12.5px] font-medium" title={a.name}>
                        {a.name}
                      </span>
                      <Icon name="pencil" size={11} className="ml-auto shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
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
        destructive
        title="这张图正在被使用"
        desc={blocked?.message}
        confirmText="强制删除"
        pending={remove.isPending}
        onConfirm={() => blocked && void doDelete(blocked.asset, true)}
      >
        <div className="max-h-[200px] space-y-0 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {blocked?.refs.map((r, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
              <Icon name="link" size={13} className="shrink-0 text-muted-foreground" />
              <span className="font-medium">{r.instanceName}</span>
              <span className="text-muted-foreground">
                第 {r.cmdIndex + 1} 条指令「{r.cmdName}」
              </span>
            </div>
          ))}
        </div>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          强制删除会把上面这些指令里的引用一并清空，那些指令需要重新选图。
        </p>
      </ConfirmDialog>
    </div>
  )
}
