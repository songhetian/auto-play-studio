import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Icon } from '@/components/icon'
import { ConfirmDialog } from '@/components/blocks/confirm-dialog'
import { EmptyState } from '@/components/blocks/empty-state'
import { PageHeader } from '@/components/blocks/page-header'
import { Field } from '@/components/blocks/field'
import { RHYTHM } from '@/components/blocks/rhythm'
import { fadeItem, staggerList } from '@/lib/motion'
import { fillTemplate, templateVars } from '@/modules/phrases/phraseTemplate'
import { useDeletePhrase, useMarkPhraseUsed, usePhrases, usePhraseCategories, useSavePhrase } from '@/modules/phrases/usePhrases'
import type { Phrase } from '@/modules/phrases/usePhrases'

/** 空表单：新增与编辑共用同一个形状，避免两处各写一遍 */
const EMPTY = { id: undefined as number | undefined, title: '', body: '', category: '' }

/**
 * 话术库：把客服每天重复回的话沉淀下来。
 *
 * 三个决定页面形态的点：
 *  - **列表默认按「常用在前」**（引擎排序），一天用几十次那句就在最上面
 *  - **搜索框和分类栏在同一行**：客服找话术的动作就是"想起来那句大概说了什么"
 *  - **编辑用右侧抽屉式弹窗**，不跳页：改一句说辞不该把列表丢掉
 */
export default function PhrasePage() {
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [draft, setDraft] = useState<typeof EMPTY | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Phrase | null>(null)
  /** 试填：让用户在发出去之前先看一句带真实数据长什么样 */
  const [preview, setPreview] = useState<Record<string, string>>({})

  const { data: list = [], isLoading } = usePhrases(q, category)
  const { data: categories = [] } = usePhraseCategories()
  // 分类计数要用**未筛选**的全量数据，否则一切到某个分类，
  // 其它分类的计数就全变成 0，筛选栏自己把自己说没了
  const { data: allItems = [] } = usePhrases()
  const countByCategory = useMemo(() => {
    const m: Record<string, number> = {}
    for (const p of allItems) if (p.category) m[p.category] = (m[p.category] ?? 0) + 1
    return m
  }, [allItems])
  const allCount = allItems.length
  const save = useSavePhrase()
  const remove = useDeletePhrase()
  const markUsed = useMarkPhraseUsed()

  const vars = useMemo(() => templateVars(draft?.body ?? ''), [draft?.body])
  const canSave = !!draft && !!draft.title.trim() && !!draft.body.trim()

  return (
    <div className={RHYTHM.pageShell}>
      <PageHeader
        icon="tag"
        title="话术库"
        desc="把常用回复沉淀下来，支持 {客户名} 这类占位符；用得越多排得越前"
        actions={
          <Button size="sm" onClick={() => setDraft({ ...EMPTY })}>
            <Icon name="plus" size={14} />
            新建话术
          </Button>
        }
      />

      {/* 搜索 + 分类：找话术的动作是"想起那句大概说了什么" */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Icon
            name="search"
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="h-8 pl-8"
            placeholder="搜标题或内容…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索话术"
          />
        </div>
        {/* 有话术才显示分类栏：空列表时一排"售后/物流"按钮点了也没反应 */}
        {!!list.length && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant={category === '' ? 'default' : 'outline'} size="sm" onClick={() => setCategory('')}>
              全部
              <span className="ml-1 font-mono text-xs opacity-70">{allCount}</span>
            </Button>
            {categories.map((c) => (
              <Button
                key={c}
                variant={category === c ? 'default' : 'outline'}
                size="sm"
                onClick={() => setCategory(c)}
              >
                {c}
                {/* 各分类有多少条 —— 不显示数字的话用户不知道该点哪个 */}
                <span className="ml-1 font-mono text-xs opacity-70">{countByCategory[c] ?? 0}</span>
              </Button>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-[76px] animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : !list.length ? (
        <EmptyState
          icon="tag"
          title={q || category ? '没有匹配的话术' : '话术库还是空的'}
          desc={
            q || category
              ? '换个关键词，或切到「全部」看看。'
              : '把每天重复回的话存进来，下次直接复制粘贴，不用重新打字。'
          }
          actions={
            !q && !category ? (
              <Button size="sm" onClick={() => setDraft({ ...EMPTY })}>
                <Icon name="plus" size={13} />
                新建话术
              </Button>
            ) : undefined
          }
        />
      ) : (
        <motion.div variants={staggerList} initial="hidden" animate="show" className="space-y-2">
          {list.map((p) => (
            <motion.div key={p.id} variants={fadeItem}>
              <Card className="transition-colors hover:border-border/80">
                <CardContent className="flex items-start gap-3 p-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-medium">{p.title}</span>
                      {p.category && <Badge variant="secondary">{p.category}</Badge>}
                      {p.usedCount > 0 && (
                        <span className="font-mono text-xs text-muted-foreground">用过 {p.usedCount} 次</span>
                      )}
                      {!!templateVars(p.body).length && (
                        <span className="text-xs text-muted-foreground">
                          {templateVars(p.body).map((v) => `{${v}}`).join(' ')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
                  </div>

                  <div className="flex flex-none items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      title="复制内容"
                      aria-label={`复制话术 ${p.title}`}
                      onClick={() => {
                        void navigator.clipboard?.writeText(p.body)
                        markUsed.mutate(p.id)
                      }}
                    >
                      <Icon name="copy" size={13} />
                      复制
                    </Button>
                    <Button variant="ghost" size="icon-sm" title="编辑" aria-label={`编辑 ${p.title}`} onClick={() => setDraft({ ...p })}>
                      <Icon name="pencil" size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="删除"
                      aria-label={`删除 ${p.title}`}
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setPendingDelete(p)}
                    >
                      <Icon name="trash" size={13} />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      )}

      {/* 编辑弹窗：改话术是高频动作，不该跳页丢掉列表上下文 */}
      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6" role="dialog" aria-modal="true">
          <Card className="w-full max-w-[560px] shadow-xl">
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-md font-semibold">{draft.id ? '编辑话术' : '新建话术'}</h3>
                <Button variant="ghost" size="icon-sm" aria-label="关闭" onClick={() => setDraft(null)}>
                  <Icon name="close" size={14} />
                </Button>
              </div>

              <Field label="标题" required hint="标题相同会覆盖原来那条，方便改话术而不是越积越多">
                <Input
                  autoFocus
                  value={draft.title}
                  maxLength={60}
                  placeholder="例如：发货通知 / 退款话术 / 催评"
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </Field>

              <Field
                label="话术内容"
                required
                hint={
                  vars.length
                    ? '可用变量：' + vars.map((v) => `{${v}}`).join('、') + '（发给具体客户时替换）'
                    : '用 {客户名} 这样的占位符，发给不同客户时只改值就行'
                }
              >
                <Textarea
                  rows={4}
                  value={draft.body}
                  placeholder="您好 {客户名}，您的订单 {订单号} 已发货，注意查收哦"
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
              </Field>

              {!!vars.length && (
                <Field label="试填看看效果" hint="只在本机预览，不会保存">
                  <div className="space-y-1.5">
                    {vars.map((v) => (
                      <Input
                        key={v}
                        className="h-7 text-sm"
                        placeholder={`${v}（留空则保留占位符）`}
                        value={preview[v] ?? ''}
                        onChange={(e) => setPreview((s) => ({ ...s, [v]: e.target.value }))}
                      />
                    ))}
                    <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm leading-relaxed">
                      {fillTemplate(draft.body, preview) || <span className="text-muted-foreground">（上面填点什么才能看效果）</span>}
                    </div>
                  </div>
                </Field>
              )}

              <Field
                label="分类"
                hint="点下面的可以直接归类；没有合适的就自己写一个（新分类会自动出现在顶部分类栏）"
              >
                <div className="space-y-2">
                  <Input
                    className="h-8"
                    value={draft.category}
                    placeholder="未分类"
                    onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  />
                  {!!categories.length && (
                    <div className="flex flex-wrap gap-1.5">
                      {categories.map((c) => (
                        <Button
                          key={c}
                          variant={draft.category === c ? 'default' : 'outline'}
                          size="sm"
                          className="h-6 text-xs"
                          onClick={() => setDraft({ ...draft, category: c })}
                        >
                          {c}
                        </Button>
                      ))}
                      {draft.category && !categories.includes(draft.category) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-xs"
                          onClick={() => setDraft({ ...draft, category: '' })}
                        >
                          <Icon name="close" size={11} />
                          清除分类
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </Field>

              <div className="flex justify-end gap-2 border-t border-border pt-3">
                <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                  取消
                </Button>
                <Button
                  size="sm"
                  disabled={!canSave || save.isPending}
                  onClick={() => {
                    if (!draft) return
                    save.mutate(
                      { id: draft.id, title: draft.title.trim(), body: draft.body.trim(), category: draft.category.trim() },
                      { onSuccess: () => { setDraft(null); setPreview({}) } },
                    )
                  }}
                >
                  <Icon name="check" size={13} />
                  保存
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(v) => !v && setPendingDelete(null)}
        action="delete"
        title={`删除话术「${pendingDelete?.title ?? ''}」？`}
        desc="删除后无法恢复。"
        confirmText="删除"
        pending={remove.isPending}
        onConfirm={() => {
          if (!pendingDelete) return
          remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) })
        }}
      />
    </div>
  )
}
