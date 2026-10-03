import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { activeNavItem, filterNav } from '@/app/navModel'
import type { NavGroup, NavItem } from '@/app/navModel'
import { useNavStore } from '@/stores/navStore'
import { useThemeStore } from '@/stores/themeStore'
import { THEME_LABEL, THEME_MODES } from '@/lib/theme'
import { useInstanceStore } from '@/stores/instanceStore'
import { engineStatusOf, useInstances } from '@/modules/console/useInstances'
import { cn } from '@/lib/utils'
import { Icon } from '@/components/icon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { fadeItem, staggerList } from '@/lib/motion'
import { useHotkeySync } from '@/modules/console/useHotkeySync'

const ENGINE_PORT = 8731

/**
 * 工具箱外壳（只用于控制台窗口）。
 *
 * 布局固定为「左侧工具导轨 + 顶部面包屑 + 内容区 + 底部状态条」：
 *  - 导轨可收成 56px 的图标条，专注跑任务时不占地方；
 *  - 分组折叠、当前项高亮都用 motion 做过渡，位置变化一眼能跟上；
 *  - 实例窗口不套这个壳（每个实例是独立窗口，打开就该只看它自己）。
 */
export default function AppShell() {
  const { pathname } = useLocation()
  const [q, setQ] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const collapsed = useNavStore((s) => s.collapsed)
  const toggleGroup = useNavStore((s) => s.toggle)
  const rail = useNavStore((s) => s.rail)
  const toggleRail = useNavStore((s) => s.toggleRail)
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)
  const instances = useInstanceStore((s) => s.instances)

  const { isPending, isError, isSuccess } = useInstances()
  const engine = engineStatusOf({ isPending, isError, isSuccess })
  // 热键注册表只在控制台同步：它是唯一能看到全部实例的地方
  const { conflicts, failed } = useHotkeySync()
  const hotkeyIssues = conflicts.length + failed.length

  const searching = q.trim().length > 0
  const groups = useMemo(() => filterNav(q), [q])
  const active = activeNavItem(pathname)

  const countByTool = useMemo(() => {
    const m: Record<string, number> = {}
    for (const i of Object.values(instances)) m[i.tool] = (m[i.tool] ?? 0) + 1
    return m
  }, [instances])

  const runningCount = useMemo(
    () => Object.values(instances).filter((i) => i.status === 'running' || i.status === 'paused' || i.status === 'starting' || i.status === 'stopping').length,
    [instances],
  )

  // 「/」聚焦搜索、「Esc」清空并失焦 —— 专业工具里导航搜索的通用手感
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setQ('')
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 换页时清掉搜索词，否则回到新页面还挂着一层过滤，容易以为功能没了
  useEffect(() => {
    setQ('')
  }, [pathname])

  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-full">
        {/* ── 工具导轨 ───────────────────────────────────────── */}
        <motion.aside
          animate={{ width: rail ? 56 : 244 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-none flex-col overflow-hidden border-r border-border bg-card"
        >
          <div className={cn('flex h-14 flex-none items-center gap-2.5 border-b border-border', rail ? 'justify-center px-0' : 'px-3.5')}>
            <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-primary text-[13px] font-medium text-primary-foreground">
              A
            </span>
            {!rail && (
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-medium leading-tight">AutoPlay Studio</div>
                <div className="truncate text-[11px] leading-tight text-muted-foreground">桌面自动化工具箱</div>
              </div>
            )}
          </div>

          {!rail && (
            <div className="flex-none px-3 pb-2 pt-2.5">
              <div className="relative">
                <Icon
                  name="search"
                  size={14}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  ref={searchRef}
                  className="h-8 pl-8 pr-8"
                  placeholder="搜索功能"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label="搜索导航功能"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2">
                  {searching ? (
                    <button
                      className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => setQ('')}
                      title="清空（Esc）"
                      aria-label="清空搜索"
                    >
                      <Icon name="close" size={13} />
                    </button>
                  ) : (
                    <Kbd>/</Kbd>
                  )}
                </span>
              </div>
            </div>
          )}

          <ScrollArea className="min-h-0 flex-1">
            <motion.nav variants={staggerList} initial="hidden" animate="show" className={cn('pb-3', rail ? 'px-2 pt-2' : 'px-2 pt-1')}>
              {groups.map((g) => (
                <NavGroupBlock
                  key={g.id}
                  group={g}
                  rail={rail}
                  activeId={active?.id}
                  forcedOpen={searching}
                  collapsed={!!collapsed[g.id]}
                  onToggle={() => toggleGroup(g.id)}
                  countByTool={countByTool}
                />
              ))}
              {!groups.length && !rail && (
                <div className="px-2.5 py-8 text-center text-[12.5px] text-muted-foreground">
                  没有匹配「{q.trim()}」的功能
                  <div className="mt-1 text-[11.5px]">试试 rpa / 物流 / 截图 / 主题</div>
                </div>
              )}
            </motion.nav>
          </ScrollArea>

          <div className={cn('flex-none border-t border-border', rail ? 'px-2 py-2.5' : 'px-3 py-3')}>
            <div className={cn('flex items-center gap-2 text-[11px] text-muted-foreground', rail && 'justify-center')}>
              <span className="relative flex size-2 flex-none">
                <span
                  className={cn(
                    'absolute inline-flex h-full w-full rounded-full opacity-70',
                    engine === 'ok' && 'animate-ping bg-[hsl(var(--ok))]',
                  )}
                />
                <span
                  className={cn(
                    'relative inline-flex size-2 rounded-full',
                    engine === 'ok' ? 'bg-[hsl(var(--ok))]' : engine === 'down' ? 'bg-destructive' : 'bg-muted-foreground/50',
                  )}
                />
              </span>
              {!rail && (
                <>
                  <span className="truncate">
                    {engine === 'ok' ? '引擎已连接' : engine === 'down' ? '引擎未连接' : '正在连接…'}
                  </span>
                  <span className="ml-auto flex-none font-mono">:{ENGINE_PORT}</span>
                </>
              )}
            </div>
          </div>
        </motion.aside>

        {/* ── 内容区 ─────────────────────────────────────────── */}
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 flex-none items-center gap-3 border-b border-border bg-card/60 px-5 backdrop-blur">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleRail}
              aria-label={rail ? '展开导航' : '收起导航'}
              title={rail ? '展开导航' : '收起导航'}
            >
              <Icon name={rail ? 'panelOpen' : 'panelClose'} size={16} />
            </Button>
            <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
              <span className="text-muted-foreground">工具箱</span>
              <Icon name="chevronRight" size={13} className="text-muted-foreground/60" />
              <span className="font-medium">{active?.label ?? 'AutoPlay Studio'}</span>
            </div>
            <div className="flex-1" />
            {hotkeyIssues > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-[hsl(var(--warn))]" asChild>
                    <Link to="/settings">
                      <Icon name="warning" size={14} />
                      {conflicts.length > 0 && <span>{conflicts.length} 处热键冲突</span>}
                      {conflicts.length === 0 && failed.length > 0 && <span>{failed.length} 个热键未生效</span>}
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[280px]">
                  {conflicts.length > 0
                    ? '多个实例绑了同一个键。按下时只会作用于其中一个（焦点实例优先），不会同时暂停全部 —— 详情见设置页。'
                    : '这些键被其它程序占用了，没注册成功：' + failed.join('、')}
                </TooltipContent>
              </Tooltip>
            )}
            {runningCount > 0 && (
              <Badge variant="success" className="gap-1.5">
                <Icon name="activity" size={12} />
                {runningCount} 个在跑
              </Badge>
            )}
            <ToggleGroup
              type="single"
              size="sm"
              value={mode}
              onValueChange={(v) => v && setMode(v as (typeof THEME_MODES)[number])}
              aria-label="外观主题"
            >
              {THEME_MODES.map((m) => (
                <ToggleGroupItem key={m} value={m} title={THEME_LABEL[m]} aria-label={THEME_LABEL[m]}>
                  <Icon name={m === 'light' ? 'sun' : m === 'dark' ? 'moon' : 'system'} size={14} />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </div>

          <footer className="flex h-7 flex-none items-center gap-4 border-t border-border bg-card/60 px-5 text-[11.5px] text-muted-foreground">
            <span className="truncate">{active?.desc ?? '桌面自动化工具箱'}</span>
            <div className="flex-1" />
            <span className="flex items-center gap-1.5">
              <Kbd>F9</Kbd> 暂停 / 继续
              <Kbd>F10</Kbd> 停止
              <span className="text-muted-foreground/70">每个实例可单独改键，只作用于一个实例</span>
            </span>
            <Separator orientation="vertical" className="h-3.5" />
            <span className="font-mono">127.0.0.1:{ENGINE_PORT}</span>
          </footer>
        </main>
      </div>
    </TooltipProvider>
  )
}

function NavGroupBlock({
  group,
  rail,
  activeId,
  forcedOpen,
  collapsed,
  onToggle,
  countByTool,
}: {
  group: NavGroup
  rail: boolean
  activeId?: string
  forcedOpen: boolean
  collapsed: boolean
  onToggle: () => void
  countByTool: Record<string, number>
}) {
  const open = rail || forcedOpen || !collapsed

  // 收窄时只剩图标，分组标题没地方放，直接平铺（用一条分隔线代替标题）
  if (rail) {
    return (
      <div className="mb-1 space-y-0.5 border-b border-border/60 pb-1.5 last:border-0">
        {group.items.map((it) => (
          <NavRow key={it.id} item={it} rail on={activeId === it.id} count={it.tool ? countByTool[it.tool] ?? 0 : 0} />
        ))}
      </div>
    )
  }

  return (
    <motion.div variants={fadeItem} className="mb-0.5">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
        <span>{group.label}</span>
        <span className="ml-auto font-mono text-[10.5px] text-muted-foreground/60">{group.items.length}</span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-0.5 space-y-px">
              {group.items.map((it) => (
                <NavRow key={it.id} item={it} on={activeId === it.id} count={it.tool ? countByTool[it.tool] ?? 0 : 0} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function NavRow({ item, on, count, rail }: { item: NavItem; on: boolean; count: number; rail?: boolean }) {
  const body = (
    <Link
      to={item.path}
      title={rail ? item.label : item.desc}
      // 选中态除了配色还要有可机读的标记：屏幕阅读器读不出来「这一条是当前页」，
      // 验收脚本也只能靠 class 猜是哪一条
      aria-current={on ? 'page' : undefined}
      className={cn(
        'group relative flex items-center gap-2.5 rounded-md text-[13px] transition-colors',
        rail ? 'h-9 justify-center px-0' : 'px-2 py-1.5',
        on ? 'text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {/* 选中背景用 layoutId 在条目之间滑动，换页时不会硬切 */}
      {on && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-md bg-primary/10"
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        />
      )}
      <span
        className={cn(
          'relative flex size-[22px] flex-none items-center justify-center rounded-md transition-colors',
          !item.color && (on ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground group-hover:text-foreground'),
        )}
        style={
          item.color
            ? on
              ? { background: item.color, color: '#fff' }
              : // 未选中也保留工具的品牌色（低透明度底 + 同色图标）：
                // 工具箱靠颜色建立「哪个工具在哪」的肌肉记忆，全灰就白搭了
                { background: `${item.color}1f`, color: item.color }
            : undefined
        }
      >
        <Icon name={item.icon} size={14} />
      </span>
      {!rail && (
        <>
          <span className="relative truncate">{item.label}</span>
          {count > 0 && <span className="relative ml-auto flex-none font-mono text-[11px] text-muted-foreground">{count}</span>}
        </>
      )}
    </Link>
  )

  if (!rail) return body
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-2">
        <span>{item.label}</span>
        {count > 0 && <span className="font-mono text-muted-foreground">{count}</span>}
      </TooltipContent>
    </Tooltip>
  )
}
