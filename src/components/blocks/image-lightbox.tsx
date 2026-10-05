import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { api } from '@/lib/api'
import type { ImageAsset } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Slider } from '@/components/ui/slider'
import { Icon } from '@/components/icon'

type Patch = { name?: string; tag?: string; threshold?: number }

/**
 * 素材详情弹窗：预览 + 改名 + 标签 + 推荐阈值，一处改完。
 *
 * 为什么不用「表格行内编辑」：图像素材的判断依据是**看得见的那张图**，
 * 把图和它的属性放在同一个弹窗里，改名时不用来回对照。
 * 改名/改标签不影响已有指令 —— 指令只记素材 ID。
 */
export function AssetDetailDialog({
  asset,
  list,
  existingTags,
  onSelect,
  onClose,
  onUpdate,
  onDelete,
  saving,
  refs,
}: {
  asset: ImageAsset | null
  /** 当前筛选结果，用于左右翻页；为空则禁用翻页 */
  list: ImageAsset[]
  existingTags: string[]
  onSelect: (a: ImageAsset) => void
  onClose: () => void
  onUpdate: (patch: Patch) => void
  onDelete?: (a: ImageAsset) => void
  saving?: boolean
  /** 被哪些指令引用（有值就在弹窗里列出来，删除前先让人看见影响面） */
  refs?: Array<{ instanceName: string; cmdIndex: number; cmdName: string }>
}) {
  const [name, setName] = useState('')
  const [tag, setTag] = useState('')
  const idx = asset ? list.findIndex((a) => a.id === asset.id) : -1
  const hasPrev = idx > 0
  const hasNext = idx >= 0 && idx < list.length - 1

  // 换图时把本地编辑态重置成当前素材，否则会带着上一张的编辑内容
  useEffect(() => {
    setName(asset?.name ?? '')
    setTag(asset?.tag ?? '')
  }, [asset?.id, asset?.name, asset?.tag])

  const go = (delta: number) => {
    if (idx < 0) return
    const next = list[idx + delta]
    if (next) onSelect(next)
  }

  useEffect(() => {
    if (!asset) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.tagName === 'INPUT') return
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, list, idx])

  const nameDirty = !!asset && !!name.trim() && name.trim() !== asset.name
  const tagDirty = !!asset && tag.trim() !== asset.tag

  const commit = () => {
    if (!asset) return
    const patch: Patch = {}
    if (nameDirty) patch.name = name.trim()
    if (tagDirty) patch.tag = tag.trim()
    if (Object.keys(patch).length) onUpdate(patch)
  }

  return (
    <Dialog open={!!asset} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[900px] gap-4 p-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-2">
            <span className="truncate">{asset?.name}</span>
            <Badge variant="secondary" className="font-mono">
              {asset ? `${asset.width}×${asset.height}` : ''}
            </Badge>
            {asset && asset.refCount > 0 && <Badge variant="default">被引用 {asset.refCount} 处</Badge>}
          </DialogTitle>
          <DialogDescription className="sr-only">预览大图、重命名并调整素材属性</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[1.35fr_1fr]">
          {/* ── 预览 ── */}
          <div
            className="relative flex min-h-[300px] items-center justify-center overflow-hidden rounded-lg border border-border p-3"
            style={{
              // 棋盘底：透明 PNG 在这里才能看出边界
              backgroundImage:
                'linear-gradient(45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--muted)) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--muted)) 75%)',
              backgroundSize: '16px 16px',
              backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
            }}
          >
            <AnimatePresence mode="wait">
              {asset && (
                <motion.img
                  key={asset.id}
                  src={api.imageRawUrl(asset.id)}
                  alt={asset.name}
                  initial={{ opacity: 0, scale: 0.985 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                  className="max-h-[44vh] max-w-full object-contain"
                />
              )}
            </AnimatePresence>

            <NavArrow dir="prev" disabled={!hasPrev} onClick={() => go(-1)} />
            <NavArrow dir="next" disabled={!hasNext} onClick={() => go(1)} />

            {idx >= 0 && (
              <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card/90 px-2 py-0.5 font-mono text-xs text-muted-foreground backdrop-blur">
                {idx + 1} / {list.length}
              </span>
            )}
          </div>

          {/* ── 属性 ── */}
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground" htmlFor="asset-name">
                素材名称
              </label>
              <Input
                id="asset-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commit()
                    ;(e.target as HTMLInputElement).blur()
                  }
                  if (e.key === 'Escape') setName(asset?.name ?? '')
                }}
                placeholder="给这张图起个一眼能认出来的名字"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground" htmlFor="asset-tag">
                标签
              </label>
              <Input
                id="asset-tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commit()
                    ;(e.target as HTMLInputElement).blur()
                  }
                  if (e.key === 'Escape') setTag(asset?.tag ?? '')
                }}
                placeholder="例如：按钮、登录页"
              />
              {existingTags.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {existingTags.slice(0, 8).map((t) => (
                    <button
                      key={t}
                      onClick={() => {
                        setTag(t)
                        onUpdate({ tag: t })
                      }}
                      className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">推荐相似度阈值</span>
                <span className="font-mono text-sm">{asset?.threshold.toFixed(2)}</span>
              </div>
              <Slider
                min={0.5}
                max={1}
                step={0.01}
                value={[asset?.threshold ?? 0.85]}
                onValueChange={([v]) => asset && onUpdate({ threshold: v })}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                新建图像指令选它时的初始值。指令上还能各自再调，互不影响。
              </p>
            </div>

            {refs && refs.length > 0 && (
              <div className="rounded-lg border border-border bg-muted/40 p-2.5">
                <div className="text-sm font-medium">正在被这些指令使用</div>
                <ul className="mt-1 space-y-1">
                  {refs.slice(0, 4).map((r, i) => (
                    <li key={i} className="text-xs leading-relaxed text-muted-foreground">
                      {r.instanceName} · 第 {r.cmdIndex + 1} 条「{r.cmdName}」
                    </li>
                  ))}
                </ul>
                {refs.length > 4 && <div className="mt-1 text-xs text-muted-foreground">…等 {refs.length} 处</div>}
              </div>
            )}

            <div className="flex items-center gap-2 pt-0.5">
              <span className="font-mono text-xs text-muted-foreground">{asset?.id}</span>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => asset && void navigator.clipboard?.writeText(asset.id)}>
                <Icon name="copy" size={12} />
                复制 ID
              </Button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border pt-4">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
            切换素材
            <span className="ml-1 text-muted-foreground/70">Enter 保存 · Esc 关闭</span>
          </span>
          <div className="flex-1" />
          {asset && (
            <Button variant="outline" size="sm" asChild>
              <a href={api.imageRawUrl(asset.id)} target="_blank" rel="noreferrer">
                <Icon name="externalLink" size={13} />
                原图
              </a>
            </Button>
          )}
          {asset && (
            <Button
              size="sm"
              variant={nameDirty || tagDirty ? 'default' : 'outline'}
              onClick={commit}
              disabled={saving || (!nameDirty && !tagDirty)}
            >
              <Icon name="check" size={13} />
              保存修改
            </Button>
          )}
          {asset && onDelete && (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              onClick={() => onDelete(asset)}
            >
              <Icon name="trash" size={13} />
              删除
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function NavArrow({ dir, disabled, onClick }: { dir: 'prev' | 'next'; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === 'prev' ? '上一张' : '下一张'}
      className={cn(
        'absolute top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card/90 text-muted-foreground shadow-sm backdrop-blur transition-all',
        'hover:text-foreground disabled:pointer-events-none disabled:opacity-0',
        dir === 'prev' ? 'left-3' : 'right-3',
      )}
    >
      <Icon name={dir === 'prev' ? 'chevronLeft' : 'chevronRight'} size={17} />
    </button>
  )
}
