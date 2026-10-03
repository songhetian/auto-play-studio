import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'motion/react'
import { api } from '@/lib/api'
import type { ImageAsset } from '@/lib/api'
import { ALL_TAGS, filterAssets, groupProblems, tagsOf } from '@/lib/assetFilter'
import { hasRegionPicker, ipc } from '@/lib/ipc'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Icon } from '@/components/icon'
import { EmptyState } from '@/components/blocks/empty-state'
import { useAssetAudit, useAssets, useCaptureAsset, useUploadAsset } from '@/modules/assets/useAssets'
import { fadeItem, staggerList } from '@/lib/motion'

/**
 * 选图器：图像指令的 assetId 从这里选出来。
 *
 * 三条进图的路都在这一个弹窗里：从库里挑、从磁盘导入、从屏幕框选。
 * 「管理素材库」是另一个页面 —— 弹窗只干「挑一张」这件事。
 */
export default function ImagePicker({
  open,
  value,
  onPick,
  onClose,
}: {
  open: boolean
  value?: string
  onPick: (asset: ImageAsset) => void
  onClose: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [kw, setKw] = useState('')
  const [tag, setTag] = useState(ALL_TAGS)
  const [note, setNote] = useState('')

  const { data: assets = [], isLoading } = useAssets(open)
  const { data: problems = [] } = useAssetAudit(open)
  const upload = useUploadAsset()
  const capture = useCaptureAsset()

  const problemsByAsset = useMemo(() => groupProblems(problems), [problems])
  const shown = useMemo(() => filterAssets(assets, { keyword: kw, tag }), [assets, kw, tag])
  const tags = useMemo(() => tagsOf(assets), [assets])

  const take = (asset: ImageAsset) => {
    onPick(asset)
    onClose()
  }

  const onUpload = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    setNote('')
    try {
      take(await upload.mutateAsync({ file }))
    } catch (e) {
      setNote((e as Error).message)
    }
  }

  const onCapture = async () => {
    setNote('')
    const region = await ipc.selectRegion()
    if (!region) return // 用户按了 Esc
    try {
      take(await capture.mutateAsync(region))
    } catch (e) {
      setNote((e as Error).message)
    }
  }

  const busy = upload.isPending || capture.isPending

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[86vh] max-w-[900px] gap-4 p-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="assets" size={15} className="text-muted-foreground" />
            选择图像素材
            <Badge variant="secondary">{shown.length} / {assets.length} 张</Badge>
          </DialogTitle>
          <DialogDescription className="sr-only">从素材库里挑一张图，或现场导入 / 框选</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-[200px]">
            <Icon
              name="search"
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input className="pl-8" placeholder="搜索素材名…" value={kw} onChange={(e) => setKw(e.target.value)} />
          </div>
          <Select value={tag} onValueChange={setTag}>
            <SelectTrigger className="w-[140px]">
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
          <div className="flex-1" />
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/bmp,image/webp"
            className="hidden"
            onChange={(e) => {
              void onUpload(e.target.files)
              e.target.value = ''
            }}
          />
          <Button variant="outline" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={13} />
            导入图片
          </Button>
          <Button
            size="sm"
            disabled={busy}
            title={hasRegionPicker ? '拉一块全屏遮罩，拖拽框选' : '框选截图需要在桌面端（Electron）中运行'}
            onClick={() => void onCapture()}
          >
            <Icon name="crop" size={13} />
            框选截图
          </Button>
        </div>

        {note && (
          <Alert variant="destructive">
            <Icon name="error" size={16} />
            <AlertDescription>{note}</AlertDescription>
          </Alert>
        )}
        {!hasRegionPicker && (
          <Alert>
            <Icon name="info" size={16} />
            <AlertDescription>框选截图需要桌面端；浏览器预览里请用「导入图片」。</AlertDescription>
          </Alert>
        )}

        <ScrollArea className="-mx-1 max-h-[54vh] px-1">
          {isLoading ? (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-[136px] rounded-xl" />
              ))}
            </div>
          ) : !shown.length ? (
            <EmptyState
              icon={assets.length ? 'search' : 'assets'}
              title={assets.length ? '没有匹配的素材' : '素材库还是空的'}
              desc={assets.length ? '换个关键词，或把标签切回「全部」。' : '先导入一张，或用框选截图现场截一块。'}
              actions={
                <Button variant="outline" size="sm" asChild>
                  <Link to="/assets">去素材库管理</Link>
                </Button>
              }
            />
          ) : (
            <motion.div
              variants={staggerList}
              initial="hidden"
              animate="show"
              className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5"
            >
              {shown.map((a) => {
                const bad = problemsByAsset[a.id] ?? []
                const current = a.id === value
                return (
                  <motion.button
                    key={a.id}
                    variants={fadeItem}
                    whileHover={{ y: -2 }}
                    onClick={() => take(a)}
                    className={`overflow-hidden rounded-xl border bg-card text-left shadow-sm transition-colors ${
                      current ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:border-primary/50'
                    }`}
                  >
                    <div
                      className="flex h-[74px] items-center justify-center border-b border-border p-1.5"
                      style={{
                        backgroundImage:
                          'linear-gradient(45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--muted)) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--muted)) 75%)',
                        backgroundSize: '14px 14px',
                        backgroundPosition: '0 0, 0 7px, 7px -7px, -7px 0',
                      }}
                    >
                      <img src={api.imageRawUrl(a.id)} alt={a.name} className="max-h-full max-w-full object-contain" />
                    </div>
                    <div className="space-y-1 p-2">
                      <div className="truncate text-[12px] font-medium" title={a.name}>
                        {a.name}
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="font-mono text-[10.5px] text-muted-foreground">
                          {a.width}×{a.height}
                        </span>
                        {current && <Badge variant="default">当前</Badge>}
                        {a.refCount > 0 && !current && <Badge variant="outline">用 {a.refCount}</Badge>}
                        {!!bad.length && (
                          <Badge variant="destructive">{bad[0].kind === 'missing_file' ? '文件丢失' : '缺失'}</Badge>
                        )}
                      </div>
                    </div>
                  </motion.button>
                )
              })}
            </motion.div>
          )}
        </ScrollArea>

        <div className="flex items-center gap-2 border-t border-border pt-3">
          <span className="text-[11.5px] text-muted-foreground">
            改名、调阈值、删除素材请到素材库；这里只负责挑一张。
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" asChild>
            <Link to="/assets">
              管理素材库
              <Icon name="arrowRight" size={13} />
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
