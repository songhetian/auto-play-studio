import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Icon } from '@/components/icon'
import { EmptyState } from '@/components/blocks/empty-state'
import { PageHeader } from '@/components/blocks/page-header'
import { Field } from '@/components/blocks/field'
import { RHYTHM } from '@/components/blocks/rhythm'
import { fadeItem, staggerList } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { useReminderStore, isoLocal } from '@/stores/reminderStore'
import { relativeTime, urgencyOf, type Reminder, type ReminderCategory } from '@/lib/reminderTime'
import { CATEGORY_LIST, categoryMeta } from './category'

/**
 * 定时提醒：设一条内容 + 一个时间，到点弹居中拦截框，防止"忙起来就忘了"。
 *
 * 页面本身只做两件事：**登记** 与**看状态**。到点弹窗不在这里 ——
 * 那是 `ReminderWatcher` 的事，它挂在 AppShell 顶层，切到哪个页面都拦得住。
 *
 * 范围提醒（写在页面 desc 里，别让人以为关机也能响）：
 * 只在 App 运行时有效。这是纯前端方案的代价，也是它换来"不用装服务"的补偿。
 */
export default function RemindersPage() {
  const reminders = useReminderStore((s) => s.reminders)
  const add = useReminderStore((s) => s.add)
  const complete = useReminderStore((s) => s.complete)
  const remove = useReminderStore((s) => s.remove)

  const [content, setContent] = useState('')
  const [at, setAt] = useState(() => defaultAt())
  const [category, setCategory] = useState<ReminderCategory>('work')
  const [showDone, setShowDone] = useState(false)

  const now = useNow(30_000)
  const pending = useMemo(() => reminders.filter((r) => !r.done), [reminders])
  const done = useMemo(() => reminders.filter((r) => r.done), [reminders])
  const shown = showDone ? [...pending, ...done] : pending

  // 逾期的排最前，其次按时间近的在前：最该处理的永远在第一行
  const sorted = useMemo(() => {
    const rank = (r: Reminder) => (urgencyOf(r.at, now) === 'overdue' ? 0 : 1)
    return [...shown].sort((a, b) => rank(a) - rank(b) || a.at.localeCompare(b.at))
  }, [shown, now])

  const canSave = !!content.trim() && !!at

  const onSave = () => {
    if (!canSave) return
    add({ content, at, category })
    setContent('')
    setAt(defaultAt())
  }

  return (
    <div className={RHYTHM.pageShell}>
      <PageHeader
        icon="bell"
        title="定时提醒"
        desc="设一件要记得做的事，到点弹窗拦住你 —— 只在 AutoPlay Studio 开着的时候有效"
        actions={
          <>
            {done.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setShowDone((v) => !v)}>
                <Icon name={showDone ? 'eye' : 'eye'} size={14} />
                {showDone ? '隐藏已完成' : `显示已完成（${done.length}）`}
              </Button>
            )}
          </>
        }
      />

      {/* 新建提醒：内容 + 时间 + 分类，三样都在一屏内 */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <Field
            label="提醒内容"
            required
            htmlFor="rem-content"
            hint="写具体一点，「到点该做什么」比「注意一下」有用得多"
          >
            <Textarea
              id="rem-content"
              rows={2}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="例如：15:00 前确认物流表已发出"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="提醒时间" required htmlFor="rem-at" hint="到点后弹窗会一直等着，直到你处理">
              <Input
                id="rem-at"
                type="datetime-local"
                value={at}
                min={isoLocal(now).slice(0, 16)}
                onChange={(e) => setAt(e.target.value)}
              />
            </Field>

            <Field label="分类" htmlFor="rem-cat" hint="决定弹窗与列表的颜色，一眼分清轻重">
              <div className="flex flex-wrap gap-1.5" id="rem-cat" role="group" aria-label="提醒分类">
                {CATEGORY_LIST.map((c) => {
                  const meta = categoryMeta(c)
                  const on = c === category
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setCategory(c)}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors',
                        on
                          ? 'border-transparent bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      <Icon name={meta.icon} size={13} />
                      {meta.label}
                    </button>
                  )
                })}
              </div>
            </Field>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={onSave} disabled={!canSave}>
              <Icon name="plus" size={14} />
              保存提醒
            </Button>
            <Button variant="ghost" size="sm" onClick={onSave} disabled={!canSave}>
              保存并再设一条
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 提醒列表 */}
      {sorted.length === 0 ? (
        <EmptyState
          icon="bell"
          title={showDone ? '还没有已完成的提醒' : '还没有提醒'}
          desc={showDone ? '完成一条之后会出现在这里，方便回看处理过什么。' : '在上面写一句要记得做的事、选个时间，到点就会弹窗拦你一次。'}
        />
      ) : (
        <motion.ul variants={staggerList} initial="hidden" animate="show" className="space-y-2">
          {sorted.map((r) => {
            const meta = categoryMeta(r.category)
            const urgency = urgencyOf(r.at, now)
            return (
              <motion.li key={r.id} variants={fadeItem}>
                <Card className={cn('transition-colors', r.done && 'opacity-60')}>
                  <CardContent className="flex items-center gap-3 p-3">
                    {/* 分类色条：不用看字也分得清是哪类 */}
                    <span className={cn('h-9 w-1 flex-none rounded-full', meta.side)} aria-hidden="true" />

                    <div className="min-w-0 flex-1">
                      <div className={cn('truncate text-base', r.done ? 'line-through text-muted-foreground' : 'font-medium')}>
                        {r.content}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-mono">{r.at.replace('T', ' ').slice(0, 16)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1">
                          <Icon name={meta.icon} size={11} />
                          {meta.label}
                        </span>
                        {!r.done && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{relativeTime(r.at, now)}</span>
                          </>
                        )}
                      </div>
                    </div>

                    {!r.done && urgency === 'overdue' && (
                      <Badge variant="destructive" className="gap-1 flex-none">
                        <Icon name="warning" size={11} />
                        已逾期
                      </Badge>
                    )}
                    {!r.done && urgency === 'soon' && (
                      <Badge variant="warning" className="flex-none">即将到期</Badge>
                    )}

                    <div className="flex flex-none items-center gap-1">
                      {!r.done && (
                        <Button size="sm" variant="ghost" onClick={() => complete(r.id)} title="标记完成">
                          <Icon name="check" size={14} />
                          完成
                        </Button>
                      )}
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => remove(r.id)}
                        title="删除"
                        aria-label={`删除提醒：${r.content}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Icon name="trash" size={14} />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.li>
            )
          })}
        </motion.ul>
      )}
    </div>
  )
}

/** 默认时间：明天的同一时刻，省得每次都要拨动日期 */
function defaultAt(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setSeconds(0, 0)
  return isoLocal(d).slice(0, 16)
}

/**
 * 每 interval 刷一次"现在"，让相对时间与逾期态自己往前走。
 * 到期弹窗另有 30 秒轮询，这里只是列表文案，1 分钟一次足够。
 */
function useNow(interval: number): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), interval)
    return () => window.clearInterval(t)
  }, [interval])
  return now
}
