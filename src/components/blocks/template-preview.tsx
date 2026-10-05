import { useMemo, useState } from 'react'

import { Icon } from '@/components/icon'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { renderTemplate, templateIssues, templateParts, TemplateError, type TemplateRow } from '@/lib/template'
import { cn } from '@/lib/utils'

/**
 * 模板实时预览。
 *
 * 存在的理由：以前模板写错了只有跑起来才知道 —— 报错藏在某一行的失败原因里。
 * 这里拿上传 Excel 时抓下来的那一样例行真值当场渲染，用户立刻看到
 * `{金额|money}` 会输出成什么、哪个列名根本不存 在。
 *
 * 判定逻辑与引擎共用 `@/lib/template`，所以「这里说没问题、跑起来才炸」不可能发生。
 */
export function TemplatePreview({
  template,
  columns,
  row,
  excelPath,
}: {
  template: string
  /** 可用的列名。为空说明还没上传 Excel，此时不报错，只提示 */
  columns: string[]
  /** 拿哪一行的真值渲染 */
  row: TemplateRow
  /** 给了就多一个「用真表头复核」按钮，让引擎重新读文件再校一遍 */
  excelPath?: string
}) {
  const [recheck, setRecheck] = useState<{ loading: boolean; done: boolean; issues: string[]; error?: string }>({
    loading: false,
    done: false,
    issues: [],
  })

  const issues = useMemo(() => (columns.length ? templateIssues(template, columns) : []), [template, columns])

  /**
   * 写错的占位符要标红。
   *
   * 切分与判定都在 `@/lib/template` 里 —— 这里只负责画。以前这段是内联的，
   * 判定喂错了入参（剥掉花括号的片段）导致**一个红字都没有**，
   * 而报错列表照常有内容，所以只读文字的验收看不出来。
   */
  const pieces = useMemo(() => templateParts(template, columns), [template, columns])

  const rendered = useMemo(() => {
    if (!template.trim() || !columns.length || issues.length) return ''
    try {
      return renderTemplate(template, row)
    } catch (err) {
      return err instanceof TemplateError ? '' : ''
    }
  }, [template, columns, row, issues.length])

  const runRecheck = async () => {
    if (!excelPath) return
    setRecheck({ loading: true, done: false, issues: [] })
    try {
      const res = await api.checkTemplate(excelPath, [template])
      setRecheck({ loading: false, done: true, issues: res.issues.map((i) => i.message) })
    } catch (err) {
      setRecheck({
        loading: false,
        done: true,
        issues: [],
        error: err instanceof Error ? err.message : '复核失败',
      })
    }
  }

  if (!template.trim()) return null

  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">预览</span>
        {!!excelPath && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-sm" disabled={recheck.loading} onClick={runRecheck}>
            <Icon name="refresh" size={12} />
            {recheck.loading ? '复核中…' : '用真表头复核'}
          </Button>
        )}
      </div>

      <div className="rounded border border-border bg-background px-2.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-all">
        {pieces.map((p, i) => (
          <span key={i} className={cn(p.bad && 'bg-destructive/10 text-destructive underline decoration-dotted')}>
            {p.text}
          </span>
        ))}
      </div>

      {issues.length > 0 && (
        <ul className="mt-2 space-y-1">
          {issues.map((m) => (
            <li key={m} className="flex gap-1.5 text-sm text-destructive">
              <Icon name="warning" size={12} className="mt-[3px] shrink-0" />
              {m}
            </li>
          ))}
        </ul>
      )}

      {!columns.length && (
        <p className="mt-2 text-sm text-muted-foreground">上传 Excel 后可在这里看到渲染效果</p>
      )}

      {!!rendered && (
        <div className="mt-2">
          <div className="mb-1 text-xs text-muted-foreground">第 {row.row_no ?? 2} 行渲染结果</div>
          <div className="rounded border border-border bg-background px-2.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-all">
            {rendered}
          </div>
        </div>
      )}

      {recheck.error && <p className="mt-2 text-sm text-destructive">复核失败：{recheck.error}</p>}
      {!recheck.loading && !recheck.error && recheck.issues.length > 0 && (
        <ul className="mt-2 space-y-1">
          {recheck.issues.map((m) => (
            <li key={m} className="flex gap-1.5 text-sm text-destructive">
              <Icon name="warning" size={12} className="mt-[3px] shrink-0" />
              {m}
            </li>
          ))}
        </ul>
      )}
      {!recheck.loading && !recheck.error && recheck.done && recheck.issues.length === 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Icon name="check" size={12} />
          引擎按真表头复核：没问题
        </p>
      )}
    </div>
  )
}
