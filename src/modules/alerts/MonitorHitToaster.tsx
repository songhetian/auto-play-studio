import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/icon'
import { cn } from '@/lib/utils'
import { matchedByLabel } from '@/lib/hitEvents'
import { snapshotUrlOf } from '@/lib/hitSnapshot'
import { accentClassOf, alertStyleOf } from '@/modules/alerts/alertTone'
import { aggregateByRound, type RoundGroup } from '@/modules/alerts/hitGrouping'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/**
 * 监控命中应用内提醒：常驻控制台顶部，命中即弹醒目横幅 + 蜂鸣。
 *
 * 为什么需要它：
 * - 原生 Windows 通知在右下角、静音/专注模式下极易错过，监控场景"没看见"等于"没报警"；
 * - 引擎侧已经会播语音、electron 侧也会播系统提示音，这里是"应用内"这一层兜底，
 *   即便窗口最小化、收进托盘，回到控制台一眼也能看到刚才命中了什么。
 *
 * 实现要点：
 * - 轮询 hitEvents(unreadOnly) 取最新未读；首次加载把已有未读标记为已见，只提示之后新到的，
 *   避免一打开就哗啦弹一堆历史；
 * - 轮询只提示、不落库：横幅到点自动消失不算有人处理过。
 *   只有用户点「确认」才把这一组记成已确认（闭环），并顺带清掉未读 —— 那是显式动作。
 */

/** 纯逻辑：从已见集合里挑出本次新到的命中 id（便于单测，且轮询复用同一份状态） */
export function detectNewHits(seen: Set<number>, items: Array<{ id: number }>): number[] {
  const fresh: number[] = []
  for (const it of items) {
    if (!seen.has(it.id)) fresh.push(it.id)
  }
  return fresh
}

/**
 * 纯逻辑：本轮最新那一组该不该响提示音。
 *
 * 抽出来是为了钉住「按**新到**的那组判级别」—— 曾经在 effect 里读了闭包中
 * 初次渲染的 `group`（恒为 null），级别恒为 info，蜂鸣一次都不响。
 */
export function shouldBeep(group: RoundGroup | null | undefined): boolean {
  if (!group) return false
  const h = group.representative
  return alertStyleOf({ tool: h.tool, level: h.level, matchedBy: h.matchedBy }).sound
}

/** 短促双音蜂鸣：浏览器自动播放策略下，桌面应用里用户早已交互过，通常可响 */
function beep() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    const tone = (freq: number, start: number, dur: number) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = freq
      o.connect(g)
      g.connect(ctx.destination)
      const t = ctx.currentTime + start
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      o.start(t)
      o.stop(t + dur + 0.02)
    }
    tone(988, 0, 0.16) // B5
    tone(740, 0.18, 0.22) // F#5
    window.setTimeout(() => ctx.close().catch(() => {}), 700)
  } catch {
    /* 音频不可用就静默，绝不影响提醒本身 */
  }
}

export function MonitorHitToaster() {
  const [group, setGroup] = useState<RoundGroup | null>(null)
  const [expanded, setExpanded] = useState(false)
  // 大图连它要显示的元信息一起存：横幅自动消失后这一层仍要能独立显示
  const [lightbox, setLightbox] = useState<{ url: string; title: string; ts: string; similarity: number | null } | null>(
    null,
  )
  const seen = useRef<Set<number>>(new Set())
  const seeded = useRef(false)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const items = await api.hitEvents({ unreadOnly: true, limit: 20 })
        if (!alive) return
        if (!seeded.current) {
          // 初次：已有未读标记已见，只提示之后新到的
          items.forEach((h) => seen.current.add(h.id))
          seeded.current = true
          return
        }
        const fresh = detectNewHits(seen.current, items)
        if (!fresh.length) return
        fresh.forEach((id) => seen.current.add(id))
        // 同一轮扫描里的画面命中聚合成一条：一次扫到 20 个目标不该弹 20 次。
        // 敏感词逐条弹（`aggregateByRound` 内部判断），因为每次可能是不同话术。
        const groups = aggregateByRound(items.filter((h) => fresh.includes(h.id)))
        setGroup(groups[0] ?? null)
        setExpanded(false)
        // 换新命中时把上一张大图关掉，免得看图时弹出的是上一次的画面
        setLightbox(null)
        // info 级只是记录一下，不该打扰。按「刚算出的最新一组」判级别 ——
        // 曾经的 `group` 是 effect 闭包里的初次渲染值（恒 null），蜂鸣永远不响
        if (shouldBeep(groups[0])) beep()
      } catch {
        /* 引擎没起也别让泵崩 */
      }
    }
    void tick()
    const timer = window.setInterval(tick, 2500)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!group) return
    // 停留时长按级别：轻的等级不该霸占视线
    const ms = alertStyleOf({ tool: group.representative.tool, level: group.representative.level, matchedBy: group.representative.matchedBy }).durationMs
    const t = window.setTimeout(() => setGroup(null), ms)
    return () => window.clearTimeout(t)
  }, [group])

  /**
   * 手动「确认」= 闭环：把这一组命中记成已处理（后端顺带清未读），再收起横幅。
   *
   * 到点自动消失只算「没看清」，不代表处理过 —— 所以确认只由这一下触发，
   * 计时器那条路绝不写库。
   */
  const confirmGroup = () => {
    const ids = group?.events.map((e) => e.id) ?? []
    setGroup(null)
    if (ids.length) void api.ackHits(ids).catch(() => {})
  }

  // 大图独立成层，放在 group 判空之外：横幅到点自动消失时这一层不能跟着被卸载 ——
  // 用户正看着大图，图不该突然消失
  const lightboxLayer = (
    <Dialog open={!!lightbox} onOpenChange={(o) => !o && setLightbox(null)}>
      <DialogContent size="wide" className="max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>命中瞬间的画面</DialogTitle>
          <DialogDescription>
            {lightbox?.title} · {lightbox?.ts} · 相似度 {lightbox?.similarity ?? '—'}
          </DialogDescription>
        </DialogHeader>
        {lightbox && (
          <img
            src={lightbox.url}
            alt="命中瞬间的画面"
            className="max-h-[65vh] w-full rounded-md border border-border object-contain"
          />
        )}
      </DialogContent>
    </Dialog>
  )

  if (!group) return <>{lightboxLayer}</>

  const hit = group.representative
  // 样式按功能与级别分型：图片命中 vs 敏感词命中不该长得一样，
  // info 级也不该用最重的红色（红色一多就等于没红色）
  const style = alertStyleOf({ tool: hit.tool, level: hit.level, matchedBy: hit.matchedBy })
  const cls = accentClassOf(style.accent)
  const snapshotUrl = snapshotUrlOf(hit.snapshot)

  return (
    <>
      {lightboxLayer}

    <div className="pointer-events-none fixed bottom-4 left-4 right-4 z-[100] flex justify-end px-4">
      <div
        role="alert"
        data-accent={style.accent}
        data-intensity={style.intensity}
        className={cn(
          'relative flex w-full max-w-[460px] items-start gap-3 overflow-hidden rounded-xl border-2 bg-card px-4 py-3',
          // 强度越高层级越明显：alert 加投影 + 更实的边框，info 只要一道细线
          style.intensity >= 2 ? 'shadow-2xl' : style.intensity === 1 ? 'shadow-lg' : 'shadow-md',
          cls.border,
        )}
      >
        {/* 左侧色条：按功能类型取色（画面/违禁词/图片/视频/意图），一眼分清是哪类事 */}
        <span className={cn('absolute inset-y-0 left-0 w-1', style.bar)} />

        {/* 命中截图：只有坐标没有画面时，判不出真命中还是误报 */}
        {snapshotUrl && (
          <button
            type="button"
            onClick={() =>
              setLightbox({ url: snapshotUrl, title: hit.title, ts: hit.ts, similarity: hit.similarity ?? null })
            }
            className="relative flex-none overflow-hidden rounded-md border border-border"
            title="看大图"
            aria-label="查看命中画面大图"
          >
            <img src={snapshotUrl} alt="命中瞬间的画面" className="h-[52px] w-[68px] object-cover" />
          </button>
        )}

        <span className={cn('mt-0.5 flex size-8 flex-none items-center justify-center rounded-full', cls.badge)}>
          <Icon name={style.icon as never} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-md font-semibold">{style.title}</span>
            {/* 聚合徽标：一条提醒代表了几次命中。只在真合并过时出现 ——
                "1 次"这种数字是噪音，不如不显示。 */}
            {group.aggregated && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                {group.count} 次
              </span>
            )}
            {/* 语气标签：同一级别下区分"这是哪一类事" */}
            <span className="text-xs text-muted-foreground">· {style.tone} · {matchedByLabel(hit.matchedBy)}</span>
          </div>
          <div className="mt-0.5 truncate text-sm text-muted-foreground" title={hit.detail}>
            {hit.title}
            {hit.detail ? ` · ${hit.detail}` : ''}
          </div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">{hit.ts}</div>

          {/* 展开看这一轮的全部命中：聚合成一条之后，得让人能钻进去核对 */}
          {expanded && group.aggregated && (
            <ul className="mt-1.5 space-y-0.5 border-l-2 border-border pl-2">
              {group.events.map((e) => (
                <li key={e.id} className="truncate text-xs text-muted-foreground" title={`${e.title} ${e.detail}`}>
                  <span className="font-mono">{e.ts.slice(11)}</span>
                  {' · '}
                  {e.title}
                  {e.detail ? ` · ${e.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-none flex-col items-end gap-1">
          {group.aggregated && (
            <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '收起' : `展开 ${group.count} 条`}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={confirmGroup} aria-label="确认已处理">
            确认
          </Button>
        </div>
      </div>
    </div>
    </>
  )
}
