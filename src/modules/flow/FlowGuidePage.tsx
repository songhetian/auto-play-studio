import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Icon } from '@/components/icon'
import { EmptyState } from '@/components/blocks/empty-state'
import { PageHeader } from '@/components/blocks/page-header'
import { Field } from '@/components/blocks/field'
import { RHYTHM } from '@/components/blocks/rhythm'
import { ConfirmDialog } from '@/components/blocks/confirm-dialog'
import { fadeItem, staggerList } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { useFlowStore } from '@/stores/flowStore'
import { parseTags } from '@/modules/flow/flowTags'
import { filterFlows, flowCategories, sortFlows, type Flow, type FlowSort } from '@/lib/flowSearch'

/**
 * 客服流程分步引导：给不熟悉的新同事一条照着做就能对的流程。
 *
 * 形态上的三个决定：
 *  - **方案是多实例**（退款/发货/投诉各一份），20 个以后靠搜索+分类收敛，
 *    不做横向排列条 —— 那东西一多就没人找得到。
 *  - **搜索覆盖步骤内容**：新人接到任务常常想不起流程名，只记得"要安抚客户"，
 *    所以搜步骤标题/说明比搜方案名更管用。
 *  - **每步 = 说明 + 截图（可选圈选框）**：纯图片做不了程序能消费的结构化内容，
 *    纯文字又说不清"点哪个按钮"，所以混合。见 docs/prd-flow-guide.md。
 */
export default function FlowGuidePage() {
  const flows = useFlowStore((s) => s.flows)
  const add = useFlowStore((s) => s.add)
  const remove = useFlowStore((s) => s.remove)
  const duplicate = useFlowStore((s) => s.duplicate)

  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [sort, setSort] = useState<FlowSort>('recent')
  const [openId, setOpenId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Flow | null>(null)

  const categories = useMemo(() => flowCategories(flows), [flows])
  const shown = useMemo(() => sortFlows(filterFlows(flows, q, category), sort), [flows, q, category, sort])
  const open = openId ? flows.find((f) => f.id === openId) : undefined

  const onCreate = () => {
    const id = add({ name: '未命名方案' })
    if (id) setOpenId(id)
  }

  return (
    <div className={RHYTHM.pageShell}>
      <PageHeader
        icon="route"
        title="客服流程分步引导"
        desc="把一套流程拆成一步一步，新同事照着做；步骤可配截图并圈出要点位置"
        actions={
          <Button size="sm" onClick={onCreate}>
            <Icon name="plus" size={14} />
            新建方案
          </Button>
        }
      />

      {/* 搜索 + 分类 + 排序：方案一多，这三样就是找东西的全部手段 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜方案名、分类，或步骤里的一句话"
            aria-label="搜索流程方案"
          />
        </div>

        {categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <CategoryChip on={!category} onClick={() => setCategory('')}>
              全部
            </CategoryChip>
            {categories.map((c) => (
              <CategoryChip key={c} on={c === category} onClick={() => setCategory(c === category ? '' : c)}>
                {c}
              </CategoryChip>
            ))}
          </div>
        )}

        <select
          className="h-8 rounded-md border border-input bg-background px-2.5 text-sm text-muted-foreground outline-none transition focus:border-ring"
          value={sort}
          onChange={(e) => setSort(e.target.value as FlowSort)}
          aria-label="排序方式"
        >
          <option value="recent">最近编辑</option>
          <option value="name">按名称</option>
          <option value="steps">步骤最多</option>
        </select>
      </div>

      {/* 结果计数：筛选后必须让人知道"还有多少被藏起来了" */}
      {flows.length > 0 && (q || category) && (
        <p className="-mt-1 text-sm text-muted-foreground">
          共 {flows.length} 个方案，当前显示 {shown.length} 个
        </p>
      )}

      {/* 方案浏览器 */}
      {shown.length === 0 ? (
        <EmptyState
          icon="route"
          title={flows.length === 0 ? '还没有流程方案' : '没有匹配的方案'}
          desc={
            flows.length === 0
              ? '新建一个方案，把「退款处理」这类流程拆成几步，新同事就能照着做。'
              : '换个词试试 —— 搜索也覆盖步骤里的内容，比如「安抚客户」。'
          }
          actions={
            flows.length === 0 ? (
              <Button size="sm" onClick={onCreate}>
                <Icon name="plus" size={14} />
                新建方案
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => { setQ(''); setCategory('') }}>
                清空筛选
              </Button>
            )
          }
        />
      ) : (
        <motion.div variants={staggerList} initial="hidden" animate="show" className={RHYTHM.grid}>
          {shown.map((f) => {
            const on = f.id === openId
            return (
              <motion.div key={f.id} variants={fadeItem}>
                <Card className={cn('h-full transition-colors', on && 'border-primary')}>
                  <CardContent className="flex h-full flex-col gap-2.5 p-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setOpenId(on ? null : f.id)}
                        aria-expanded={on}
                      >
                        <span className="block truncate text-base font-medium">{f.name}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {f.steps.length} 步
                          {f.updatedAt && ` · ${f.updatedAt.slice(0, 10)}`}
                        </span>
                      </button>
                      {on && <Badge className="flex-none">当前</Badge>}
                    </div>

                    {f.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {f.tags.map((t) => (
                          <Badge key={t} variant="outline">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {/* 步骤进度小条：一眼看出这个流程走到哪了 */}
                    <div className="flex gap-0.5" aria-hidden="true">
                      {f.steps.slice(0, 8).map((s) => (
                        <span key={s.id} className="h-1 flex-1 rounded-full bg-primary/35 first:bg-primary" />
                      ))}
                    </div>

                    <div className="mt-auto flex items-center gap-1 pt-1">
                      <Button size="sm" variant={on ? 'default' : 'outline'} onClick={() => setOpenId(f.id)}>
                        {on ? '收起' : '打开'}
                      </Button>
                      <Button size="icon-sm" variant="ghost" onClick={() => duplicate(f.id)} title="复制方案" aria-label={`复制方案 ${f.name}`}>
                        <Icon name="copy" size={13} />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => setPendingDelete(f)}
                        title="删除方案"
                        aria-label={`删除方案 ${f.name}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Icon name="trash" size={13} />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            )
          })}
        </motion.div>
      )}

      {/* 打开的方案：分步阅读 + 编辑。
          key={open.id} 是必须的：FlowDetail 内部持有「当前第几步」的状态，
          不加 key 就会在切换方案时被复用 —— 从 A 的第 3 步切到 B，预览直接落在
          B 的第 3 步；标签输入框（非受控）也还显示着 A 的标签。 */}
      {open && <FlowDetail key={open.id} flow={open} onClose={() => setOpenId(null)} />}

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title="删除方案"
        desc={pendingDelete ? `「${pendingDelete.name}」的 ${pendingDelete.steps.length} 个步骤会一起删掉，删了就找不回来了。` : ''}
        confirmText="删除"
        tone="danger"
        onConfirm={() => {
          if (pendingDelete) {
            remove(pendingDelete.id)
            if (openId === pendingDelete.id) setOpenId(null)
          }
          setPendingDelete(null)
        }}
      />
    </div>
  )
}

function CategoryChip({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-sm transition-colors',
        on
          ? 'border-transparent bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/** 方案详情：左侧步骤编辑、右侧分步阅读（照着做的那一面） */
function FlowDetail({ flow, onClose }: { flow: Flow; onClose: () => void }) {
  const update = useFlowStore((s) => s.update)
  const addStep = useFlowStore((s) => s.addStep)
  const updateStep = useFlowStore((s) => s.updateStep)
  const removeStep = useFlowStore((s) => s.removeStep)
  const moveStep = useFlowStore((s) => s.moveStep)

  const [idx, setIdx] = useState(0)
  const step = flow.steps[Math.min(idx, flow.steps.length - 1)]

  const onAddStep = () => {
    const id = `step-${Math.random().toString(36).slice(2, 9)}`
    addStep(flow.id, { id, title: `第 ${flow.steps.length + 1} 步`, desc: '' })
    setIdx(flow.steps.length)
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <Field label="方案名称" htmlFor={`name-${flow.id}`}>
              <Input
                id={`name-${flow.id}`}
                value={flow.name}
                onChange={(e) => update(flow.id, { name: e.target.value })}
              />
            </Field>
          </div>
          <div className="min-w-[200px] flex-1">
            <Field label="分类标签" htmlFor={`tags-${flow.id}`} hint="多个用逗号分隔，用于筛选">
              <Input
                id={`tags-${flow.id}`}
                defaultValue={flow.tags.join('、')}
                onBlur={(e) => update(flow.id, { tags: parseTags(e.target.value) })}
                placeholder="售后、物流"
              />
            </Field>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            收起
          </Button>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* 步骤列表：可增删、上下移、改内容 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">步骤（{flow.steps.length}）</span>
              <Button size="sm" variant="outline" onClick={onAddStep}>
                <Icon name="plus" size={13} />
                加一步
              </Button>
            </div>

            {flow.steps.length === 0 ? (
              <EmptyState icon="route" title="还没有步骤" desc="点「加一步」拆出第一步。" />
            ) : (
              <ul className="space-y-2">
                {flow.steps.map((s, i) => (
                  <li key={s.id}>
                    <Card className={cn('transition-colors', i === idx && 'border-primary')}>
                      <CardContent className="space-y-2 p-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="flex size-5 flex-none items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                            {i + 1}
                          </span>
                          <Input
                            className="h-7 flex-1"
                            value={s.title}
                            onChange={(e) => updateStep(flow.id, s.id, { title: e.target.value })}
                            aria-label={`第 ${i + 1} 步标题`}
                          />
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => moveStep(flow.id, s.id, -1)}
                            disabled={i === 0}
                            title="上移"
                            aria-label="上移"
                          >
                            <Icon name="chevronUp" size={13} />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => moveStep(flow.id, s.id, 1)}
                            disabled={i === flow.steps.length - 1}
                            title="下移"
                            aria-label="下移"
                          >
                            <Icon name="chevronDown" size={13} />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => removeStep(flow.id, s.id)}
                            title="删除这一步"
                            aria-label={`删除第 ${i + 1} 步`}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Icon name="trash" size={13} />
                          </Button>
                        </div>
                        <Textarea
                          rows={2}
                          value={s.desc}
                          onChange={(e) => updateStep(flow.id, s.id, { desc: e.target.value })}
                          placeholder="具体点哪个按钮、填什么，让新人照着做就对"
                          aria-label={`第 ${i + 1} 步说明`}
                        />
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 分步阅读：新人真正照着做的那一面 */}
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">分步预览</span>
              <div className="flex-1" />
              <span className="text-xs text-muted-foreground">
                第 {flow.steps.length ? Math.min(idx, flow.steps.length - 1) + 1 : 0} / {flow.steps.length} 步
              </span>
            </div>

            {flow.steps.length > 0 && (
              <Progress value={((Math.min(idx, flow.steps.length - 1) + 1) / flow.steps.length) * 100} />
            )}

            {step ? (
              <>
                <div className="space-y-1.5">
                  <h3 className="text-md font-medium">{step.title}</h3>
                  {step.desc ? (
                    <p className="whitespace-pre-wrap rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed">
                      {step.desc}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">这一步还没写说明。</p>
                  )}
                </div>

                {step.image && (
                  <figure className="overflow-hidden rounded-md border border-border">
                    <div className="relative">
                      <img src={step.image} alt={`${step.title} 的界面截图`} className="block w-full" />
                      {/* 圈选框用比例坐标，图片缩放时位置不会跑 */}
                      {step.rect && (
                        <span
                          className="pointer-events-none absolute rounded-sm border-2 border-destructive"
                          style={{
                            left: `${step.rect.x * 100}%`,
                            top: `${step.rect.y * 100}%`,
                            width: `${step.rect.w * 100}%`,
                            height: `${step.rect.h * 100}%`,
                          }}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                    <figcaption className="border-t border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground">
                      红框是要点的位置
                    </figcaption>
                  </figure>
                )}

                <div className="flex items-center gap-2 pt-0.5">
                  <Button size="sm" variant="outline" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}>
                    <Icon name="chevronLeft" size={13} />
                    上一步
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setIdx((i) => Math.min(flow.steps.length - 1, i + 1))}
                    disabled={idx >= flow.steps.length - 1}
                  >
                    下一步
                    <Icon name="chevronRight" size={13} />
                  </Button>
                </div>

                {/* 步骤缩略导航：能直接跳到某一步，不用一路点「下一步」 */}
                <div className="flex flex-wrap gap-1 border-t border-border pt-2.5">
                  {flow.steps.map((s, i) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setIdx(i)}
                      aria-current={i === idx ? 'step' : undefined}
                      className={cn(
                        'max-w-[9rem] truncate rounded px-2 py-1 text-xs transition-colors',
                        i === idx
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      {i + 1}. {s.title}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">左侧加第一步后，这里会出现分步预览。</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
