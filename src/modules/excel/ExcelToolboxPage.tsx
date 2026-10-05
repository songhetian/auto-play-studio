import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Icon } from '@/components/icon'
import { PageHeader } from '@/components/blocks/page-header'
import { Field } from '@/components/blocks/field'
import { PathPicker } from '@/components/blocks/path-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { toolById, toolGroups, type ToolId } from './toolboxModel'
import {
  useToolboxColumns,
  useToolboxConvert,
  useToolboxDedupe,
  useToolboxFilter,
  useToolboxGenerate,
  useToolboxMerge,
  useToolboxProblemRows,
  useToolboxSplit,
} from './useExcelToolbox'
import type { FillColumn, ToolboxResult } from '@/lib/api'

/** 一行匹配键：主表列 ↔ 来源表列。列数由用户自己加，不是固定两列 */
interface KeyPair {
  main: string
  src: string
}

/** 一列补全字段，可改名 */
interface FillField {
  from: string
  to: string
}

const NO_VALUE = '__none__'

/**
 * Excel 工具箱：七个围绕 xlsx 的小工具，共用「选表 → 配参数 → 执行」的骨架。
 *
 * 三个贯穿全页的约定：
 *  1. **原文件只读**，产出是同目录的新文件（`原名_已合并.xlsx`）——
 *     批处理工具覆盖原表不可逆，这个工具箱不给这个选项。
 *  2. **列是动态的**：匹配列、补全字段、保留列都是「加一行就多一列」，
 *     没有「主键列 / 副键列」这种写死两列的说法。
 *  3. 选表后立刻读出列名填进下拉，用户不用去记忆表里有哪些列。
 */
export default function ExcelToolboxPage() {
  const [tool, setTool] = useState<ToolId>('merge')
  const current = toolById(tool)!

  return (
    <div className="mx-auto max-w-[1240px] p-5">
      <PageHeader
        icon="sheet"
        title="Excel 工具箱"
        desc="围绕表格的七个批处理小工具；原文件只读，产出是同目录下的新文件"
      />

      <div className="mt-5 grid gap-4 lg:grid-cols-[212px_minmax(0,1fr)]">
        {/* 左侧工具栏：分组 + 当前项高亮 */}
        <nav className="space-y-4" aria-label="工具列表">
          {toolGroups().map((g) => (
            <div key={g.id}>
              <div className="px-2 pb-1.5 text-xs font-medium tracking-wide text-muted-foreground">{g.label}</div>
              <div className="space-y-px">
                {g.items.map((t) => {
                  const on = t.id === tool
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTool(t.id)}
                      aria-current={on ? 'page' : undefined}
                      title={t.desc}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-base transition-colors',
                        on ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      <Icon name={t.icon} size={14} />
                      <span className="truncate">{t.name}</span>
                      {t.primary && (
                        <span className="ml-auto rounded bg-primary/10 px-1 text-2xs font-medium text-primary">
                          常用
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* 右侧工作区 */}
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-md font-medium">
                  <Icon name={current.icon} size={15} className="text-muted-foreground" />
                  {current.name}
                </h2>
                <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-muted-foreground">{current.desc}</p>
              </div>
            </div>

            <ToolPanel tool={tool} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/** 按工具分发到各自的参数面板 */
function ToolPanel({ tool }: { tool: ToolId }) {
  switch (tool) {
    case 'merge':
      return <MergePanel />
    case 'generate':
      return <GeneratePanel />
    case 'dedupe':
      return <DedupePanel />
    case 'convert':
      return <ConvertPanel />
    case 'split':
      return <SplitPanel />
    case 'problem':
      return <ProblemPanel />
    case 'filter':
      return <FilterPanel />
    default:
      return null
  }
}

/** 执行结果条：产出路径 + 行数，并提供「打开所在文件夹」 */
function ResultBar({ result, extra }: { result: ToolboxResult | null; extra?: React.ReactNode }) {
  if (!result) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ok/30 bg-ok/8 px-3 py-2.5">
      <Icon name="success" size={15} className="text-ok" />
      <span className="text-sm">
        已产出 <span className="font-medium">{result.rowCount}</span> 行
        {extra}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={result.path}>
        {result.path}
      </span>
    </div>
  )
}

/** 列多选：用 chip 而不是多选框，一眼能看到选了哪些、随时能点掉 */
function ColumnChips({
  columns,
  picked,
  onChange,
  emptyHint,
}: {
  columns: string[]
  picked: string[]
  onChange: (next: string[]) => void
  emptyHint?: string
}) {
  if (!columns.length) {
    return <p className="text-sm text-muted-foreground">{emptyHint ?? '先选一张表，这里会列出它的列。'}</p>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {columns.map((c) => {
        const on = picked.includes(c)
        return (
          <button
            key={c}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? picked.filter((x) => x !== c) : [...picked, c])}
            className={cn(
              'rounded-full border px-2.5 py-1 text-sm transition-colors',
              on
                ? 'border-transparent bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {c}
          </button>
        )
      })}
    </div>
  )
}

// ── 合并 / 补全 ───────────────────────────────────────────────

function MergePanel() {
  const [mainPath, setMainPath] = useState('')
  const [srcPath, setSrcPath] = useState('')
  const [keys, setKeys] = useState<KeyPair[]>([{ main: '', src: '' }])
  const [fills, setFills] = useState<FillField[]>([])

  const mainCols = useToolboxColumns(mainPath)
  const srcCols = useToolboxColumns(srcPath)
  const run = useToolboxMerge()

  const addKey = () => setKeys((k) => [...k, { main: '', src: '' }])
  const addFill = () => setFills((f) => [...f, { from: '', to: '' }])

  const canRun =
    !!mainPath &&
    !!srcPath &&
    keys.some((k) => k.main && k.src) &&
    fills.some((f) => f.from) &&
    !run.isPending

  const onRun = () => {
    const fillColumns: FillColumn[] = fills
      .filter((f) => f.from)
      .map((f) => (f.to && f.to !== f.from ? { from: f.from, to: f.to } : f.from))
    run.mutate(
      {
        mainPath,
        srcPath,
        mainKeys: keys.filter((k) => k.main && k.src).map((k) => k.main),
        srcKeys: keys.filter((k) => k.main && k.src).map((k) => k.src),
        fillColumns,
      },
      {
        onSuccess: () => {
          setFills((f) => (f.length === 1 && !f[0].from ? [] : f))
        },
      },
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="主表" required htmlFor="tb-main" hint="保留主表原有的全部列">
          <PathPicker value={mainPath} onChange={setMainPath} placeholder="订单表.xlsx" accept="xlsx;csv" />
        </Field>
        <Field label="补全来源表" required htmlFor="tb-src" hint="只把你要的列拉过来">
          <PathPicker value={srcPath} onChange={setSrcPath} placeholder="物流表.xlsx" accept="xlsx;csv" />
        </Field>
      </div>

      <Field
        label="匹配关键列"
        required
        hint="两表靠这些列对齐。可以加到任意多列（如「订单号 + 买家」一起才唯一）"
      >
        <div className="space-y-2">
          {keys.map((k, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <ColumnSelect
                value={k.main}
                onChange={(v) => setKeys((all) => all.map((x, j) => (j === i ? { ...x, main: v } : x)))}
                options={mainCols.data?.columns ?? []}
                placeholder="主表列"
                disabled={!mainPath}
              />
              <Icon name="arrowRight" size={13} className="flex-none text-muted-foreground" />
              <ColumnSelect
                value={k.src}
                onChange={(v) => setKeys((all) => all.map((x, j) => (j === i ? { ...x, src: v } : x)))}
                options={srcCols.data?.columns ?? []}
                placeholder="来源表列"
                disabled={!srcPath}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={() => setKeys((all) => (all.length > 1 ? all.filter((_, j) => j !== i) : all))}
                disabled={keys.length === 1}
                title="删除这一组匹配列"
                aria-label="删除这一组匹配列"
                className="text-muted-foreground hover:text-destructive"
              >
                <Icon name="trash" size={13} />
              </Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={addKey}>
            <Icon name="plus" size={13} />
            添加匹配列
          </Button>
        </div>
      </Field>

      <Field label="补全字段" hint="从来源表拉哪些列过来；填「改名」可以改产出表里的列名">
        <div className="space-y-2">
          {fills.map((f, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <ColumnSelect
                value={f.from}
                onChange={(v) => setFills((all) => all.map((x, j) => (j === i ? { ...x, from: v } : x)))}
                options={srcCols.data?.columns ?? []}
                placeholder="来源表列"
                disabled={!srcPath}
              />
              <Input
                className="h-8 w-[132px]"
                value={f.to}
                onChange={(e) => setFills((all) => all.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))}
                placeholder="改名（可留空）"
                aria-label="补全后的列名"
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={() => setFills((all) => all.filter((_, j) => j !== i))}
                title="删除这个字段"
                aria-label="删除这个字段"
                className="text-muted-foreground hover:text-destructive"
              >
                <Icon name="trash" size={13} />
              </Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={addFill} disabled={!srcPath}>
            <Icon name="plus" size={13} />
            添加字段
          </Button>
        </div>
      </Field>

      <ErrorText error={run.error} />

      <div className="flex items-center gap-2">
        <Button onClick={onRun} disabled={!canRun} loading={run.isPending}>
          <Icon name="play" size={14} />
          执行并生成新表
        </Button>
        <span className="text-xs text-muted-foreground">
          原表不动，产出「{mainPath ? mainPath.split(/[\\/]/).pop()?.replace(/\.\w+$/, '') : '主表'}_已合并.xlsx」
        </span>
      </div>

      <ResultBar
        result={run.data ?? null}
        extra={
          run.data?.matchedCount !== undefined ? (
            <>
              ，其中 <span className="font-medium">{run.data.matchedCount}</span> 行匹配上了来源表
            </>
          ) : null
        }
      />
    </div>
  )
}

// ── 生成新表 ───────────────────────────────────────────────────

function GeneratePanel() {
  const [path, setPath] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const cols = useToolboxColumns(path)
  const run = useToolboxGenerate()

  return (
    <div className="space-y-4">
      <Field label="源表" required htmlFor="tb-gen" hint="勾掉不要的列，剩下的按勾选顺序写进新表">
        <PathPicker value={path} onChange={setPath} placeholder="订单表.xlsx" accept="xlsx;csv" />
      </Field>

      <Field label={`保留的列（已选 ${picked.length}）`} hint="点击切换；新表的列顺序 = 你点击的顺序">
        <ColumnChips
          columns={cols.data?.columns ?? []}
          picked={picked}
          onChange={setPicked}
          emptyHint={path ? '这张表没有可用列。' : '先选一张表，这里会列出它的所有列。'}
        />
      </Field>

      {picked.length > 0 && (
        <p className="text-xs text-muted-foreground">
          新表列序：{picked.join(' → ')}
        </p>
      )}

      <ErrorText error={run.error} />

      <Button onClick={() => run.mutate({ path, columns: picked })} disabled={!path || run.isPending} loading={run.isPending}>
        <Icon name="play" size={14} />
        生成新表
      </Button>

      <ResultBar result={run.data ?? null} />
    </div>
  )
}

// ── 去重 ───────────────────────────────────────────────────────

function DedupePanel() {
  const [path, setPath] = useState('')
  const [keys, setKeys] = useState<string[]>([])
  const cols = useToolboxColumns(path)
  const run = useToolboxDedupe()

  return (
    <div className="space-y-4">
      <Field label="表格" required htmlFor="tb-dedupe" hint="原表不动，产出去重后的新表">
        <PathPicker value={path} onChange={setPath} placeholder="订单表.xlsx" accept="xlsx;csv" />
      </Field>

      <Field label="业务键" hint="按这些列判重重，保留第一条。不选则按整行内容判重">
        <ColumnChips columns={cols.data?.columns ?? []} picked={keys} onChange={setKeys} />
      </Field>

      <ErrorText error={run.error} />

      <Button onClick={() => run.mutate({ path, keys })} disabled={!path || run.isPending} loading={run.isPending}>
        <Icon name="play" size={14} />
        去重并生成新表
      </Button>

      <ResultBar
        result={run.data ?? null}
        extra={
          run.data && 'removedCount' in run.data ? (
            <>
              ，去掉 <span className="font-medium">{run.data.removedCount}</span> 条重复
            </>
          ) : null
        }
      />
    </div>
  )
}

// ── 格式互转 ───────────────────────────────────────────────────

function ConvertPanel() {
  const [path, setPath] = useState('')
  const [target, setTarget] = useState<'xlsx' | 'csv'>('csv')
  const run = useToolboxConvert()

  return (
    <div className="space-y-4">
      <Field label="源文件" required htmlFor="tb-conv">
        <PathPicker value={path} onChange={setPath} placeholder="订单表.xlsx 或 订单表.csv" accept="xlsx;csv" />
      </Field>

      <Field label="转成" required htmlFor="tb-target">
        <Select value={target} onValueChange={(v) => setTarget(v as 'xlsx' | 'csv')}>
          <SelectTrigger id="tb-target" className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="csv">csv（Excel 打开不乱码）</SelectItem>
            <SelectItem value="xlsx">xlsx</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <ErrorText error={run.error} />

      <Button onClick={() => run.mutate({ path, target })} disabled={!path || run.isPending} loading={run.isPending}>
        <Icon name="play" size={14} />
        开始转换
      </Button>

      <ResultBar result={run.data ?? null} />
    </div>
  )
}

// ── 按列拆分 ───────────────────────────────────────────────────

function SplitPanel() {
  const [path, setPath] = useState('')
  const [column, setColumn] = useState('')
  const cols = useToolboxColumns(path)
  const run = useToolboxSplit()
  const [openFiles, setOpenFiles] = useState(false)

  return (
    <div className="space-y-4">
      <Field label="源表" required htmlFor="tb-split">
        <PathPicker value={path} onChange={setPath} placeholder="物流表.xlsx" accept="xlsx;csv" />
      </Field>

      <Field label="按哪一列拆" required htmlFor="tb-split-col" hint="每个不同的值生成一个文件，空值归到「空」">
        <Select value={column} onValueChange={setColumn} disabled={!path}>
          <SelectTrigger id="tb-split-col" className="w-[240px]">
            <SelectValue placeholder={path ? '选一列' : '先选表'} />
          </SelectTrigger>
          <SelectContent>
            {(cols.data?.columns ?? []).map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <ErrorText error={run.error} />

      <Button onClick={() => run.mutate({ path, column })} disabled={!path || !column || run.isPending} loading={run.isPending}>
        <Icon name="play" size={14} />
        拆成多个文件
      </Button>

      {run.data && run.data.files.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
          <div className="flex items-center gap-2 text-sm">
            <Icon name="success" size={14} className="text-ok" />
            拆出了 <span className="font-medium">{run.data.files.length}</span> 个文件
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpenFiles((v) => !v)}>
              {openFiles ? '收起' : '展开清单'}
            </Button>
          </div>
          {openFiles && (
            <ul className="space-y-1 pt-1">
              {run.data.files.map((f) => (
                <li key={f.path} className="flex items-center gap-2 text-xs">
                  <Badge variant="secondary">{f.value}</Badge>
                  <span className="text-muted-foreground">{f.rowCount} 行</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={f.path}>
                    {f.path}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ── 问题行导出 ─────────────────────────────────────────────────

function ProblemPanel() {
  const [path, setPath] = useState('')
  const [keyCol, setKeyCol] = useState('')
  const cols = useToolboxColumns(path)
  const run = useToolboxProblemRows()

  return (
    <div className="space-y-4">
      <Field label="要体检的表" required htmlFor="tb-prob" hint="挑出空主键与主键重复的行">
        <PathPicker value={path} onChange={setPath} placeholder="订单表.xlsx" accept="xlsx;csv" />
      </Field>

      <Field label="主键列" htmlFor="tb-prob-key" hint="不选就只查整行为空">
        <Select value={keyCol} onValueChange={setKeyCol} disabled={!path}>
          <SelectTrigger id="tb-prob-key" className="w-[240px]">
            <SelectValue placeholder={path ? '选一列（可选）' : '先选表'} />
          </SelectTrigger>
          <SelectContent>
            {(cols.data?.columns ?? []).map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <ErrorText error={run.error} />

      <Button onClick={() => run.mutate({ path, keyColumn: keyCol })} disabled={!path || run.isPending} loading={run.isPending}>
        <Icon name="play" size={14} />
        导出问题行
      </Button>

      <ResultBar
        result={run.data ?? null}
        extra={
          <>
            ，含 Excel 行号与问题原因，可直接回原表改
          </>
        }
      />
    </div>
  )
}

// ── 条件筛选导出 ───────────────────────────────────────────────

function FilterPanel() {
  const [path, setPath] = useState('')
  const [column, setColumn] = useState('')
  const [value, setValue] = useState('')
  const cols = useToolboxColumns(path)
  const run = useToolboxFilter()

  return (
    <div className="space-y-4">
      <Field label="源表" required htmlFor="tb-filter">
        <PathPicker value={path} onChange={setPath} placeholder="订单表.xlsx" accept="xlsx;csv" />
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="筛选列" htmlFor="tb-filter-col">
          <Select value={column} onValueChange={setColumn} disabled={!path}>
            <SelectTrigger id="tb-filter-col">
              <SelectValue placeholder={path ? '选一列' : '先选表'} />
            </SelectTrigger>
            <SelectContent>
              {(cols.data?.columns ?? []).map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="等于" htmlFor="tb-filter-val" hint="留空表示全部导出">
          <Input
            id="tb-filter-val"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="例如：已签收"
            disabled={!column}
          />
        </Field>
      </div>

      <ErrorText error={run.error} />

      <Button onClick={() => run.mutate({ path, column, value })} disabled={!path || run.isPending} loading={run.isPending}>
        <Icon name="play" size={14} />
        导出子集
      </Button>

      <ResultBar result={run.data ?? null} />
    </div>
  )
}

// ── 小件 ───────────────────────────────────────────────────────

/** 列下拉。`columns` 为空时给一句人话，而不是一个空下拉 */
function ColumnSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder: string
  disabled?: boolean
}) {
  return (
    <Select value={value || NO_VALUE} onValueChange={(v) => onChange(v === NO_VALUE ? '' : v)} disabled={disabled || !options.length}>
      <SelectTrigger className="w-[152px]">
        <SelectValue placeholder={options.length ? placeholder : '先选表'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((c) => (
          <SelectItem key={c} value={c}>
            {c}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** 统一的错误展示：引擎给的是给人看的中文，直接透出 */
function ErrorText({ error }: { error: unknown }) {
  if (!error) return null
  const msg = error instanceof Error ? error.message : String(error)
  return (
    <p className="flex items-start gap-1.5 text-sm leading-relaxed text-destructive">
      <Icon name="error" size={13} className="mt-0.5 flex-none" />
      {msg}
    </p>
  )
}
