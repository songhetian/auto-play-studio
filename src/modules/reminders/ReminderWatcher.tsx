import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useReminderStore } from '@/stores/reminderStore'
import { countdownOf, remainLabel, urgencyOf, type Reminder } from '@/lib/reminderTime'
import { CATEGORY_META } from '@/modules/reminders/category'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Icon } from '@/components/icon'
import { cn } from '@/lib/utils'

/** 轮询间隔：30 秒一次。桌面工具不需要秒级精度，也省得空转 */
const TICK_MS = 30_000

/**
 * 全局到期提醒弹窗：到点了就拦住，必须明确处理（完成 / 稍后）。
 *
 * 为什么是拦截式而不是右上角 toast —— 这个功能的全部意义是"防遗漏"，
 * toast 会自己消失，等于把提醒又变回"可能错过"。所以：
 *  - 不自动关闭（Radix Dialog 默认行为就是不给 open 传 false，靠 state 控）
 *  - 一次只弹一条，按时间先后逐条处理，避免三张卡糊一脸
 *
 * 挂在 AppShell 顶层：切到哪个页面都该拦，所以不能放在某个业务页里。
 */
export function ReminderWatcher() {
  const complete = useReminderStore((s) => s.complete)
  const snooze = useReminderStore((s) => s.snooze)
  const [active, setActive] = useState<Reminder | null>(null)

  // 弹窗打开期间单独跑一个秒级时钟喂给倒计时。
  // 上面的 TICK_MS 轮询在"仍在到期"时 setActive 会返回同一个引用、
  // React 据此跳过重渲染 —— 于是剩余时间和进度条会冻住不动。
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!active) return
    setNow(new Date())
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [active])

  // 每 TICK_MS 醒一次看有没有新的到期项；顺手用当前时间刷新"剩多久"，
  // 所以这里存的是提醒本身而不是一个布尔值。
  useEffect(() => {
    const check = () => {
      const due = useReminderStore.getState().due(new Date())
      setActive((cur) => {
        // 正在弹的那条先让它弹完：完成/稍后会把它移出 due 列表，
        // 这里只负责"没有在弹的时候"补上下一条
        if (cur) {
          const stillDue = due.some((r) => r.id === cur.id)
          return stillDue ? cur : (due[0] ?? null)
        }
        return due[0] ?? null
      })
    }
    check()
    const t = window.setInterval(check, TICK_MS)
    return () => window.clearInterval(t)
  }, [])

  const onDone = () => {
    if (active) complete(active.id)
    setActive(null)
  }
  const onSnooze = () => {
    if (active) snooze(active.id, 5)
    setActive(null)
  }

  return (
    <Dialog
      open={!!active}
      onOpenChange={(o) => {
        // 点遮罩/Esc 也算"稍后"——直接消失会让人以为提醒没了
        if (!o) onSnooze()
      }}
    >
      <DialogContent size="default" tone="primary" className="gap-0 p-0" aria-describedby="reminder-desc">
        <AnimatePresence mode="wait">
          {active && (
            <motion.div
              key={active.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              <ReminderBody reminder={active} now={now} />
            </motion.div>
          )}
        </AnimatePresence>
        <DialogFooter className="border-t border-border bg-muted/40 px-6 py-3.5">
          <Button onClick={onDone}>
            <Icon name="check" size={14} />
            完成
          </Button>
          <Button variant="outline" onClick={onSnooze}>
            <Icon name="clock" size={14} />
            稍后 5 分钟
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 弹窗主体：分类色条 + 图标 + 内容 + 相对时间。`now` 由上层每秒推一次以驱动倒计时 */
function ReminderBody({ reminder, now }: { reminder: Reminder; now: Date }) {
  const meta = CATEGORY_META[reminder.category]
  const urgency = urgencyOf(reminder.at, now)
  const count = countdownOf(reminder, now)

  return (
    <>
      {/* 分类色条：一眼分清是工作还是物流的提醒 */}
      <div className={cnBar(meta.bar)} />

      <DialogHeader className="gap-0 px-6 pb-4 pt-5">
        <div className="flex items-center gap-3">
          <span className={cnIcon(meta)}>
            <Icon name={meta.icon} size={17} />
          </span>
          <div className="min-w-0">
            <div className="text-sm text-muted-foreground">提醒 · {meta.label}</div>
            <DialogTitle>该处理这件事了</DialogTitle>
          </div>
        </div>
      </DialogHeader>

      <div className="px-6 pb-5">
        <p id="reminder-desc" className="rounded-lg border border-border bg-muted/50 px-3.5 py-3 text-base leading-relaxed">
          {reminder.content}
        </p>

        {/* 倒计时：给这个弹窗"必须处理"的视觉权重。
            之前它只有一段文字 + 两个按钮，看上去比命中横幅还轻 ——
            而它恰恰是唯一不能自动消失的那类提醒。 */}
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
          <span className="font-mono">{reminder.at.replace('T', ' ').slice(0, 16)}</span>
          <span className={urgency === 'overdue' ? 'font-medium text-destructive' : 'font-medium text-foreground'}>
            {remainLabel(reminder.at, now)}
          </span>
        </div>
        <div
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={count.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="距离到期的剩余时间"
        >
          <div
            className={cn('h-full rounded-full transition-[width] duration-500', meta.side)}
            style={{ width: `${count.percent}%` }}
          />
        </div>

        {urgency === 'overdue' && (
          <Badge variant="destructive" className="mt-2 gap-1">
            <Icon name="warning" size={11} />
            已逾期
          </Badge>
        )}
      </div>
    </>
  )
}

function cnBar(bar: string) {
  return `h-1 w-full ${bar}`
}

function cnIcon(meta: { ring: string; bg: string; fg: string }) {
  return `flex size-9 flex-none items-center justify-center rounded-lg ring-1 ${meta.ring} ${meta.bg} ${meta.fg}`
}
