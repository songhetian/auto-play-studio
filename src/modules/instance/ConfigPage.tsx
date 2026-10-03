import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { api } from '@/lib/api'
import { ipc, hasRegionPicker } from '@/lib/ipc'
import { useInstanceStore } from '@/stores/instanceStore'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Icon } from '@/components/icon'
import { Dropzone } from '@/components/Dropzone'
import { EmptyState } from '@/components/blocks/empty-state'
import { Field } from '@/components/blocks/field'
import { PageHeader } from '@/components/blocks/page-header'
import { HotkeyEditor } from '@/components/blocks/hotkey-editor'
import CompareConfig from '@/modules/instance/CompareConfig'
import CmdFlowEditor from '@/modules/instance/CmdFlowEditor'
import { useAssets } from '@/modules/assets/useAssets'
import ImagePicker from '@/modules/assets/ImagePicker'
import { instanceConfigSchema } from '@/schemas/instance'
import { zodFieldErrors } from '@/lib/configValidation'
import { formatRegion, parseRegion, regionCoverage } from '@/lib/region'
import { formatAccel, hotkeyMapOf } from '@/lib/hotkey'
import { fadeUp, staggerList } from '@/lib/motion'
import type { MonitorRegion } from '@/lib/region'
import type { HotkeyAction, HotkeyMap } from '@/lib/hotkey'
import type { LogiConfig, MacroConfig, RpaConfig } from '@/schemas/instance'

/** Radix Select 不接受空字符串作为 item value，用哨兵值表示「不设置」 */
const NONE = '__none__'

/** 校验错误路径 → 人话字段名，用于「还差哪几项」的提示 */
const FIELD_LABEL: Record<string, string> = {
  window: '绑定窗口',
  'rpa.excelPath': 'Excel 数据源',
  'rpa.colName': '客户名称列',
  'rpa.from': '起始行',
  'rpa.to': '结束行',
  'rpa.cmds': '流程指令',
  'macro.cmds': '指令序列',
  'logi.file': 'Excel 文件',
  'logi.colWaybill': '物流单号列',
  'logi.site.url': '查询页 URL',
  'cmp.primaryFields': '主键字段',
}

/** 指令序列内部字段 → 人话，配合「第 N 条指令的…」用 */
const CMD_FIELD_LABEL: Record<string, string> = {
  t: '名称',
  p: '参数',
  'key.combo': '按键',
  'key': '按键',
  'image.assetId': '图像素材',
  'image': '图像素材',
}

/** `rpa.cmds.3.key.combo` → 「第 4 条指令的按键」；macro 的指令序列同构，路径一起认 */
const CMD_PATH = /^(?:rpa|macro)\.cmds\.(\d+)\.(.+)$/

const labelOf = (path: string) => {
  if (FIELD_LABEL[path]) return FIELD_LABEL[path]
  const m = CMD_PATH.exec(path)
  if (m) return `第 ${Number(m[1]) + 1} 条指令的${CMD_FIELD_LABEL[m[2]] ?? m[2]}`
  return path
}

/**
 * 列名选择器：选项来自上传后探测到的表头。
 *
 * 当前值即使不在新表头里也保留为一项 —— 换了文件之后直接把旧列名吞掉，
 * 用户会以为配置自己丢了，不如留着让他看见并改。
 */
function ColumnSelect({
  value,
  columns,
  onChange,
  placeholder,
  optional,
}: {
  value: string
  columns: string[]
  onChange: (v: string) => void
  placeholder?: string
  optional?: boolean
}) {
  if (!columns.length) {
    return <Input value={value} disabled placeholder="先上传 Excel，自动识别列名" />
  }
  const options = value && !columns.includes(value) ? [value, ...columns] : columns
  return (
    <Select value={value === '' && optional ? NONE : value} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder ?? '请选择'} />
      </SelectTrigger>
      <SelectContent>
        {optional && <SelectItem value={NONE}>{placeholder ?? '不设置'}</SelectItem>}
        {options.map((c) => (
          <SelectItem key={c} value={c}>
            {c}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** 站点适配器的一个字段：标签 + 受控输入框 */
function SiteField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Field label={label}>
      <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </Field>
  )
}

export default function ConfigPage() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const inst = useInstanceStore((s) => s.instances[id])
  const instances = useInstanceStore((s) => s.instances)
  const setCmds = useInstanceStore((s) => s.setCmds)
  const patchCmd = useInstanceStore((s) => s.patchCmd)
  const patchConfig = useInstanceStore((s) => s.patchConfig)
  const [tab, setTab] = useState<'data' | 'flow'>('data')
  const [windows, setWindows] = useState<Array<{ title: string; process: string; pid: number }>>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerIdx, setPickerIdx] = useState(-1)
  // 指令序列的摘要要显示素材名而不是 id，所以这里也读一次库（与属性面板共用缓存）
  const { data: assets = [] } = useAssets()

  useEffect(() => {
    ipc.listWindows().then(setWindows)
  }, [])

  // ── 未保存标记 ──
  // 所有编辑都先落在本地 store，点「保存配置」才回写引擎；
  // 有一个基线快照，才能诚实告诉用户「你改了但还没保存」。
  const [baseline, setBaseline] = useState<{ id: string; json: string } | null>(null)
  useEffect(() => {
    if (inst && baseline?.id !== inst.id) setBaseline({ id: inst.id, json: JSON.stringify(inst.config) })
  }, [inst, baseline?.id])
  const dirty = !!inst && baseline?.id === inst.id && baseline.json !== JSON.stringify(inst.config)

  const saveMut = useMutation({
    mutationFn: () => api.saveConfig(id, inst!.config),
    onSuccess: () => {
      setBaseline({ id, json: JSON.stringify(inst!.config) })
      qc.invalidateQueries({ queryKey: ['instances'] })
    },
  })

  const uploadMut = useMutation({
    mutationFn: (f: File) => api.uploadExcel(id, f),
    onSuccess: (res) => {
      // 上传后把探测到的表头写进配置，列映射才有的可选；
      // 行区间也交给后端给的值，避免默认区间把数据全漏掉。
      if (inst?.config.tool === 'rpa') {
        patchConfig(id, {
          rpa: {
            excelPath: res.path,
            from: 2,
            to: Math.max(2, res.rows + 1),
            columns: res.columns,
            // 样例行存进配置，刷新之后预览依然在 —— 否则每次进页面都得重传一次 Excel
            sample: res.sample,
          },
        })
      } else if (inst?.config.tool === 'logi') {
        patchConfig(id, { logi: { file: res.path, columns: res.columns } })
      }
    },
  })

  // 字段级校验：保存按钮的可用性与错误提示都来自同一份结果
  const errors = useMemo(() => (inst ? zodFieldErrors(instanceConfigSchema, inst.config) : {}), [inst])
  const err = (path: string) => errors[path]
  const errorPaths = Object.keys(errors)

  // Ctrl/Cmd + S 保存：桌面工具的肌肉记忆
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (inst && !Object.keys(zodFieldErrors(instanceConfigSchema, inst.config)).length) saveMut.mutate()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /**
   * 绑定的窗口可能已经关掉了，当前值仍要留在选项里，否则看起来像配置丢了。
   *
   * **这个 hook 必须留在 `if (!inst) return` 之前。** 实例数据是从 store 里异步来的，
   * 冷启动时 `inst` 先是 undefined（走上面的空态早退），拿到数据后再变成有值 ——
   * hook 一旦写在早退之后，两次渲染的 hook 数量就不一样，
   * React 会直接抛 "Rendered more hooks than during the previous render"（#310）：
   * 整棵树上屏失败，用户看到的是一片白。
   *
   * 这条路径只有「直接冷启动到配置页」才会走到。从控制台点进实例时 store 里已经有数据
   * （persist 从 localStorage 同步恢复），第一次渲染 `inst` 就是有值的，所以一直没暴露。
   */
  const windowOptions = useMemo(() => {
    const titles = windows.map((w) => w.title)
    const cur = inst && (inst.config.tool === 'rpa' || inst.config.tool === 'macro') ? inst.config.window : ''
    return cur && !titles.includes(cur) ? [cur, ...titles] : titles
  }, [windows, inst])

  if (!inst) {
    return (
      <EmptyState
        className="h-full"
        icon="error"
        title="实例不存在或已被删除"
        desc="它可能已经在这个窗口之外被删掉了，回到控制台的实例管理里确认一下。"
      />
    )
  }

  // 判别式收窄只在直接判断处生效，先各取一次
  const rpa: RpaConfig | null = inst.config.tool === 'rpa' ? inst.config.rpa : null
  const logi: LogiConfig | null = inst.config.tool === 'logi' ? inst.config.logi : null
  const macro: MacroConfig | null = inst.config.tool === 'macro' ? inst.config.macro : null
  const isRpa = rpa !== null
  const isMacro = macro !== null
  const isLogi = logi !== null
  const isCmp = inst.config.tool === 'cmp'
  const isMonitor = inst.config.tool === 'monitor'
  const monitor = inst.config.tool === 'monitor' ? inst.config : null
  /** macro 的绑定窗口在配置根上（与 rpa 同构），不在 macro 子对象里 */
  const macroWindow = inst.config.tool === 'macro' ? inst.config.window : ''

  /** 属性面板里可一键插入的变量：来自当前实例配置的列名 */
  const variables = rpa ? [rpa.colName, rpa.colMsg].filter((c): c is string => !!c) : []
  const assetNameOf = (assetId: string) => assets.find((a) => a.id === assetId)?.name

  const setRpa = (patch: Partial<RpaConfig>) => patchConfig(id, { rpa: patch })
  /** 局部改 logi 配置里的一层字段（patchConfig 做嵌套合并，不会抹掉 site 之外的东西） */
  const setLogi = (patch: Partial<LogiConfig>) => patchConfig(id, { logi: patch })
  const setSite = (field: keyof NonNullable<LogiConfig['site']>, value: string) =>
    setLogi({ site: { name: '', url: '', input: '', button: '', result: '', status: '', trace: '', ...(logi?.site ?? {}), [field]: value } })

  // ── 监控区域：结构化编辑，回写成配置字符串 ──
  const region = parseRegion(monitor?.region)
  const setRegion = (r: MonitorRegion) => patchConfig(id, { region: formatRegion(r) })
  const setRegionField = (patch: Partial<Omit<Extract<MonitorRegion, { kind: 'rect' }>, 'kind'>>) => {
    const base = region.kind === 'rect' ? region : { x: 0, y: 0, width: 800, height: 600 }
    setRegion({ kind: 'rect', ...base, ...patch })
  }

  const rules = monitor?.rules ?? []
  const updateRule = (i: number, patch: Partial<{ assetId: string; threshold: number }>) =>
    patchConfig(id, { rules: rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) })
  const addRule = () => patchConfig(id, { rules: [...rules, { assetId: '', threshold: 0.85 }] })
  const removeRule = (i: number) => patchConfig(id, { rules: rules.filter((_, idx) => idx !== i) })
  const onPickRegion = async () => {
    const picked = await ipc.selectRegion()
    if (!picked) return
    setRegion({ kind: 'rect', x: picked.x, y: picked.y, width: picked.width, height: picked.height })
  }

  // ── 全局快捷键：实例级字段，读写都走 config.hotkeys 这一条路径 ──
  const hk = hotkeyMapOf(inst.config)
  const writeHotkeys = (patch: Partial<HotkeyMap>) => patchConfig(id, { hotkeys: { ...hk, ...patch } })
  /** 其它实例里绑了同一个键的名字，用于就地提示冲突 */
  const conflictsOf = (action: HotkeyAction, accel: string) =>
    Object.values(instances)
      .filter((i) => i.id !== id)
      .filter((i) => hotkeyMapOf(i.config)[action] === accel)
      .map((i) => i.name)

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as 'data' | 'flow')}>
      <div className="space-y-4 p-5">
        <PageHeader
          icon="sliders"
          title={
            <span className="flex items-center gap-2">
              实例配置
              <Badge variant="default" className="font-mono">
                {inst.id}
              </Badge>
              {dirty && <Badge variant="warning">未保存</Badge>}
            </span>
          }
          desc="配置只对当前实例生效，与其它实例隔离"
          actions={
            <>
              {(isRpa || isMacro) && (
                <TabsList>
                  <TabsTrigger value="data">{isRpa ? '数据与配置' : '窗口绑定'}</TabsTrigger>
                  <TabsTrigger value="flow">{isRpa ? '流程编排' : '指令序列'}</TabsTrigger>
                </TabsList>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => ipc.openInstance({ id, tool: inst.tool, name: inst.name, route: `/instance/${id}/run` })}
              >
                <Icon name="externalLink" size={13} />
                前往运行详情
              </Button>
              {!isCmp && (
                <Button
                  size="sm"
                  onClick={() => saveMut.mutate()}
                  disabled={saveMut.isPending || errorPaths.length > 0}
                  title={errorPaths.length ? `还有 ${errorPaths.length} 项没填完` : '保存配置（Ctrl+S）'}
                >
                  <Icon
                    name={saveMut.isPending ? 'refresh' : errorPaths.length > 0 ? 'warning' : 'check'}
                    size={13}
                    className={saveMut.isPending ? 'animate-spin' : undefined}
                  />
                  {saveMut.isPending
                    ? '保存中…'
                    : errorPaths.length > 0
                      ? '待补齐'
                      : dirty
                        ? '保存配置'
                        : '已保存'}
                </Button>
              )}
            </>
          }
        />

        {!isCmp && errorPaths.length > 0 && (
          <Alert variant="warning">
            <Icon name="warning" size={16} />
            <AlertDescription>
              还有 <b className="font-medium">{errorPaths.length}</b> 项需要补齐才能保存：
              {errorPaths.slice(0, 5).map((p) => labelOf(p)).join('、')}
              {errorPaths.length > 5 ? ' 等' : ''}
            </AlertDescription>
          </Alert>
        )}

        {saveMut.isError && (
          <Alert variant="destructive">
            <Icon name="error" size={16} />
            <AlertDescription>保存失败：{(saveMut.error as Error).message}</AlertDescription>
          </Alert>
        )}

        <motion.div variants={staggerList} initial="hidden" animate="show" className="space-y-4">
          {/* ③ Excel 多表对比：自带保存，单独成页 */}
          {isCmp && (
            <motion.div variants={fadeUp}>
              <CompareConfig id={id} />
            </motion.div>
          )}

          {/* ① Excel 类：拖拽上传 + 列映射 + 执行策略 */}
          {isRpa && rpa && (
            <>
              <TabsContent value="data" className="mt-0">
                <motion.div variants={fadeUp} className="grid grid-cols-12 gap-4">
                  <div className="col-span-12 space-y-4 lg:col-span-7">
                    <Card>
                      <CardHeader>
                        <CardTitle>数据源</CardTitle>
                        <Badge variant="secondary">{rpa.columns.length ? `${rpa.columns.length} 列` : '未读取'}</Badge>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <Dropzone onFile={(f) => uploadMut.mutate(f)} hint="上传后自动识别列名与行数" />
                        <div className="text-[12px] text-muted-foreground">
                          当前文件：<span className="text-foreground">{rpa.excelPath || '未选择'}</span>
                        </div>
                        {err('rpa.excelPath') && <p className="text-[11.5px] text-destructive">{err('rpa.excelPath')}</p>}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle>列映射</CardTitle>
                        <span className="text-[12px] text-muted-foreground">下拉项取自 Excel 表头</span>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="grid grid-cols-3 gap-3">
                          <Field label="客户名称列（搜索关键词）" error={err('rpa.colName')}>
                            <ColumnSelect
                              value={rpa.colName}
                              columns={rpa.columns}
                              onChange={(v) => setRpa({ colName: v })}
                              placeholder="请选择"
                            />
                          </Field>
                          <Field label="消息内容列" hint="统一发送内容开启后忽略">
                            <ColumnSelect value={rpa.colMsg ?? ''} columns={rpa.columns} onChange={(v) => setRpa({ colMsg: v })} optional placeholder="不使用" />
                          </Field>
                          <Field label="状态列" hint="留空则自动创建「执行状态」列">
                            <ColumnSelect value={rpa.colStatus ?? ''} columns={rpa.columns} onChange={(v) => setRpa({ colStatus: v })} optional placeholder="自动创建" />
                          </Field>
                        </div>
                        <Separator />
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                              <div className="text-[13px] font-medium">启用统一发送内容</div>
                              <div className="mt-0.5 text-[12px] text-muted-foreground">开启后忽略 Excel「消息内容列」，所有行发同一段内容</div>
                            </div>
                            <Switch checked={rpa.unified} onCheckedChange={(v) => setRpa({ unified: v })} />
                          </div>
                          {rpa.unified && (
                            <Textarea
                              className="min-h-[84px]"
                              value={rpa.unifiedText}
                              onChange={(e) => setRpa({ unifiedText: e.target.value })}
                              placeholder="每行都会发送这段内容，可用 {客户名称} 占位"
                            />
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle>执行策略</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="grid grid-cols-4 gap-3">
                          <Field label="起始行" error={err('rpa.from')}>
                            <Input
                              type="number"
                              min={1}
                              value={rpa.from}
                              onChange={(e) => setRpa({ from: e.target.value === '' ? 1 : Number(e.target.value) })}
                            />
                          </Field>
                          <Field label="结束行" error={err('rpa.to')}>
                            <Input
                              type="number"
                              min={1}
                              value={rpa.to}
                              onChange={(e) => setRpa({ to: e.target.value === '' ? 1 : Number(e.target.value) })}
                            />
                          </Field>
                          <Field label="失败重试">
                            <Input
                              type="number"
                              min={0}
                              value={rpa.retry}
                              onChange={(e) => setRpa({ retry: e.target.value === '' ? 0 : Number(e.target.value) })}
                            />
                          </Field>
                          <Field label="失败后">
                            <Select value={rpa.onFail} onValueChange={(v) => setRpa({ onFail: v as RpaConfig['onFail'] })}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="continue">标记并继续</SelectItem>
                                <SelectItem value="pause">暂停等待</SelectItem>
                              </SelectContent>
                            </Select>
                          </Field>
                        </div>
                        <Separator />
                        <div className="flex flex-wrap gap-x-7 gap-y-3">
                          <span className="flex items-center gap-2 text-[13px]">
                            <Switch checked={rpa.skipSuccess} onCheckedChange={(v) => setRpa({ skipSuccess: v })} />
                            跳过已「成功」的行
                          </span>
                          <span className="flex items-center gap-2 text-[13px]">
                            <Switch checked={rpa.writeReason} onCheckedChange={(v) => setRpa({ writeReason: v })} />
                            回写失败原因
                          </span>
                          <span className="flex items-center gap-2 text-[13px]">
                            <Switch checked={rpa.backup} onCheckedChange={(v) => setRpa({ backup: v })} />
                            执行前备份 Excel
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  <div className="col-span-12 lg:col-span-5">
                    <Card>
                      <CardHeader>
                        <CardTitle>绑定窗口</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <Field label="目标窗口" error={err('window')} hint="列表由主进程枚举，仅影响当前实例">
                          <Select
                            value={inst.config.tool === 'rpa' ? inst.config.window || NONE : NONE}
                            onValueChange={(v) => patchConfig(id, { window: v === NONE ? '' : v })}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="请选择要绑定的窗口" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE}>请选择要绑定的窗口</SelectItem>
                              {windowOptions.map((t) => {
                                const w = windows.find((x) => x.title === t)
                                return (
                                  <SelectItem key={t} value={t}>
                                    {t}
                                    {w ? ` — ${w.process}` : '（已关闭）'}
                                  </SelectItem>
                                )
                              })}
                            </SelectContent>
                          </Select>
                        </Field>
                        <div className="rounded-lg border border-border bg-muted/50 p-3 text-[12px] text-muted-foreground">
                          运行时会先激活这个窗口再执行指令；请保持窗口标题不变，标题变了需要重新选择。
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                </motion.div>
              </TabsContent>

              {/* ② 流程编排：指令库 + 可拖拽排序画布 + 属性（macro 共用同一套） */}
              <TabsContent value="flow" className="mt-0">
                <CmdFlowEditor
                  cmds={rpa.cmds}
                  variables={variables}
                  columns={rpa.columns}
                  sample={rpa.sample}
                  excelPath={rpa.excelPath}
                  hasDataSource
                  assetNameOf={assetNameOf}
                  onChange={(next) => setCmds(id, next)}
                  onPatch={(index, patch) => patchCmd(id, index, patch)}
                />
              </TabsContent>
            </>
          )}

          {/* ③ 物流工具：上传 → 选单号列 → 查询方式 */}
          {isLogi && logi && (
            <motion.div variants={fadeUp} className="grid grid-cols-12 gap-4">
              <div className="col-span-12 space-y-4 lg:col-span-7">
                <Card>
                  <CardHeader>
                    <CardTitle>上传 Excel</CardTitle>
                    <Badge variant="secondary">支持拖拽上传</Badge>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Dropzone onFile={(f) => uploadMut.mutate(f)} hint="上传后自动检测所有列名" />
                    <Field label="物流单号列" error={err('logi.colWaybill')} hint={logi.file ? `当前文件：${logi.file}` : undefined}>
                      <ColumnSelect value={logi.colWaybill} columns={logi.columns} onChange={(v) => setLogi({ colWaybill: v })} placeholder="请选择" />
                    </Field>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>查询方式</CardTitle>
                    <Badge variant="secondary">不依赖接口也能用</Badge>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      {(
                        [
                          ['excel', '① Excel 匹配合并', '用平台导出的物流表按单号合并，纯本地最快最稳', false],
                          ['web', '② 网页自动化查询', '复用 RPA 引擎打开查询页读取结果，无需申请接口', false],
                          ['api', '③ 接口查询', '快递100 / 顺丰 / 京东官方，需密钥（预留）', true],
                        ] as Array<[LogiConfig['provider'], string, string, boolean]>
                      ).map(([key, title, desc, disabled]) => (
                        <button
                          key={key}
                          type="button"
                          disabled={disabled}
                          onClick={() => setLogi({ provider: key })}
                          className={`rounded-lg border p-3 text-left transition-colors ${
                            disabled
                              ? 'cursor-not-allowed opacity-50'
                              : logi.provider === key
                                ? 'border-primary bg-primary/[0.06] ring-1 ring-primary/20'
                                : 'border-border hover:border-primary/50 hover:bg-accent/40'
                          }`}
                        >
                          <div className="text-[13px] font-medium">{title}</div>
                          <div className="mt-1 text-[11.5px] text-muted-foreground">{desc}</div>
                        </button>
                      ))}
                    </div>
                    <div className="rounded-lg border border-border bg-muted/50 p-3 text-[12px] text-muted-foreground">
                      原文件保持只读，查询结果写入新文件；已查过的单号进本地缓存，不重复查询
                    </div>
                  </CardContent>
                </Card>

                {logi.provider === 'web' && (
                  <Card>
                    <CardHeader>
                      <CardTitle>站点适配器</CardTitle>
                      <Badge variant="warning">按目标网站填写选择器</Badge>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <SiteField label="适配器名称" value={logi.site?.name ?? ''} onChange={(v) => setSite('name', v)} placeholder="如 顺丰官网" />
                      <SiteField label="查询页 URL" value={logi.site?.url ?? ''} onChange={(v) => setSite('url', v)} placeholder="https://www.example.com/track" />
                      <SiteField label="单号输入框选择器" value={logi.site?.input ?? ''} onChange={(v) => setSite('input', v)} placeholder="如 #waybill-no" />
                      <SiteField label="查询按钮选择器" value={logi.site?.button ?? ''} onChange={(v) => setSite('button', v)} placeholder="如 #search-btn" />
                      <SiteField label="结果容器选择器" value={logi.site?.result ?? ''} onChange={(v) => setSite('result', v)} placeholder="如 .track-result" />
                      <SiteField label="状态文本选择器" value={logi.site?.status ?? ''} onChange={(v) => setSite('status', v)} placeholder="如 .status-text" />
                      <SiteField label="轨迹文本选择器" value={logi.site?.trace ?? ''} onChange={(v) => setSite('trace', v)} placeholder="如 .trace-list" />
                      <Separator />
                      <div className="flex items-center justify-between gap-4 pt-1">
                        <span className="text-[12.5px] text-muted-foreground">遇验证码自动暂停，转人工处理</span>
                        <Switch checked={logi.pauseOnCaptcha ?? true} onCheckedChange={(v) => setLogi({ pauseOnCaptcha: v })} />
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>

              <div className="col-span-12 lg:col-span-5">
                <Card>
                  <CardHeader>
                    <CardTitle>输出设置</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Field label="输出文件" hint="结果写入新文件，不覆盖原文件（文件名由原文件派生，运行时可改）">
                      <Input
                        readOnly
                        value={logi.file ? logi.file.replace(/\.(xlsx|xls|csv)$/i, '') + '_物流信息.xlsx' : '（上传后自动生成）'}
                      />
                    </Field>
                    <div className="space-y-1.5">
                      <Label>写入列</Label>
                      <div className="flex flex-wrap gap-2">
                        {['物流公司', '物流状态', '签收时间', '最新轨迹'].map((c) => (
                          <Badge key={c} variant="default">
                            {c}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </motion.div>
          )}

          {/* ④ 桌面图片监控：复用 notic 检测内核，监测屏幕区域，目标图出现即记录 */}
          {isMonitor && monitor && (
            <motion.div variants={fadeUp} className="grid grid-cols-12 gap-4">
              <div className="col-span-12 space-y-4 lg:col-span-7">
                <Card>
                  <CardHeader>
                    <CardTitle>监控范围</CardTitle>
                    <Badge variant="secondary">{regionCoverage(region)}</Badge>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="space-y-1.5">
                      <Label>查找范围</Label>
                      <div className="flex flex-wrap gap-2">
                        <Button variant={region.kind === 'full' ? 'default' : 'outline'} size="sm" onClick={() => setRegion({ kind: 'full' })}>
                          整屏
                        </Button>
                        <Button variant={region.kind === 'rect' ? 'default' : 'outline'} size="sm" onClick={() => setRegionField({})}>
                          自定义区域
                        </Button>
                        <div className="flex-1" />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!hasRegionPicker}
                          title={hasRegionPicker ? '拉一块全屏遮罩，拖拽框选监控区域' : '框选需要在桌面端（Electron）中运行'}
                          onClick={() => void onPickRegion()}
                        >
                          <Icon name="crop" size={13} />
                          框选区域
                        </Button>
                      </div>
                    </div>

                    {region.kind === 'rect' && (
                      <div className="grid grid-cols-4 gap-3">
                        <Field label="X">
                          <Input type="number" value={region.x} onChange={(e) => setRegionField({ x: Number(e.target.value) || 0 })} />
                        </Field>
                        <Field label="Y">
                          <Input type="number" value={region.y} onChange={(e) => setRegionField({ y: Number(e.target.value) || 0 })} />
                        </Field>
                        <Field label="宽">
                          <Input type="number" min={1} value={region.width} onChange={(e) => setRegionField({ width: Number(e.target.value) || 1 })} />
                        </Field>
                        <Field label="高">
                          <Input type="number" min={1} value={region.height} onChange={(e) => setRegionField({ height: Number(e.target.value) || 1 })} />
                        </Field>
                      </div>
                    )}

                    <div className="text-[12px] text-muted-foreground">
                      只会在选定范围内查找目标图，范围越小误报越少；坐标为屏幕物理像素。
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>监控目标（规则）</CardTitle>
                    <Badge variant="secondary">{rules.length} 条</Badge>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {rules.map((r, i) => (
                      <div key={i} className="flex items-center gap-3 rounded-lg border border-border p-3">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9 gap-2"
                          onClick={() => {
                            setPickerIdx(i)
                            setPickerOpen(true)
                          }}
                        >
                          {r.assetId ? (
                            <>
                              <img src={api.imageRawUrl(r.assetId)} alt="" className="h-5 w-5 object-contain" />
                              <span className="max-w-[140px] truncate">{assetNameOf(r.assetId) ?? '素材已不在库'}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">选择目标图片</span>
                          )}
                        </Button>
                        <div className="flex flex-1 items-center gap-3">
                          <Slider className="flex-1" value={[r.threshold]} min={0.5} max={1} step={0.01} onValueChange={([v]) => updateRule(i, { threshold: v })} />
                          <span className="w-12 text-right font-mono text-[12px] tabular-nums">{r.threshold.toFixed(2)}</span>
                        </div>
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => removeRule(i)}>
                          <Icon name="trash" size={13} />
                          删除
                        </Button>
                      </div>
                    ))}
                    {!rules.length && <EmptyState icon="assets" title="还没有监控目标" desc="添加一张目标图片，出现即记录" />}
                    <Button variant="outline" size="sm" onClick={addRule}>
                      <Icon name="plus" size={13} />
                      添加监控目标
                    </Button>
                  </CardContent>
                </Card>
              </div>

              <div className="col-span-12 lg:col-span-5">
                <Card>
                  <CardHeader>
                    <CardTitle>说明</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-[13px] leading-relaxed text-muted-foreground">
                    <p>复用 notic 的 OpenCV 模板匹配内核：持续抓屏，对每张目标图做多尺度匹配。</p>
                    <p>相似度达到阈值即记为一次命中，写入运行日志与命中记录，画面持续存在只报一次。</p>
                    <p>参考图直接复用图像素材库，删除素材会一并失效该规则。</p>
                  </CardContent>
                </Card>
              </div>
            </motion.div>
          )}

          {/* ⑤ 按键精灵：绑定窗口 + 指令序列，一次跑一遍，没有数据源 */}
          {isMacro && macro && (
            <>
              <TabsContent value="data" className="mt-0">
                <motion.div variants={fadeUp} className="grid grid-cols-12 gap-4">
                  <div className="col-span-12 lg:col-span-7">
                    <Card>
                      <CardHeader>
                        <CardTitle>绑定窗口</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <Field label="目标窗口" error={err('window')} hint="列表由主进程枚举，仅影响当前实例">
                          <Select value={macroWindow || NONE} onValueChange={(v) => patchConfig(id, { window: v === NONE ? '' : v })}>
                            <SelectTrigger>
                              <SelectValue placeholder="请选择要绑定的窗口" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE}>请选择要绑定的窗口</SelectItem>
                              {windowOptions.map((t) => {
                                const w = windows.find((x) => x.title === t)
                                return (
                                  <SelectItem key={t} value={t}>
                                    {t}
                                    {w ? ` — ${w.process}` : '（已关闭）'}
                                  </SelectItem>
                                )
                              })}
                            </SelectContent>
                          </Select>
                        </Field>
                        <div className="rounded-lg border border-border bg-muted/50 p-3 text-[12px] leading-relaxed text-muted-foreground">
                          每次执行前会先把目标窗口切到前台。找不到这个窗口时整轮直接失败 ——
                          在没有目标窗口的情况下继续按键，等于往「此刻恰好在前台」的窗口里乱按。
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  <div className="col-span-12 lg:col-span-5">
                    <Card>
                      <CardHeader>
                        <CardTitle>怎么触发</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3 text-[13px] leading-relaxed text-muted-foreground">
                        <p className="flex flex-wrap items-center gap-1.5">
                          在运行详情页点「执行一次」，或随时按
                          <Kbd>{formatAccel(hk.run)}</Kbd>
                          —— 焦点在目标程序上也按得到。
                        </p>
                        <p>宏没有数据源：不分行、不回写表格，执行一次就把整串动作按顺序走一遍，逐条记在运行详情里。</p>
                        <p>触发键在页面下方的「快捷键」里改；想换一个不影响别处的键，就改这里的「开始执行」。</p>
                      </CardContent>
                    </Card>
                  </div>
                </motion.div>
              </TabsContent>

              <TabsContent value="flow" className="mt-0">
                <CmdFlowEditor
                  cmds={macro.cmds}
                  variables={[]}
                  columns={[]}
                  hasDataSource={false}
                  assetNameOf={assetNameOf}
                  onChange={(next) => setCmds(id, next)}
                  onPatch={(index, patch) => patchCmd(id, index, patch)}
                />
              </TabsContent>
            </>
          )}

          {/* 全局快捷键：随实例走，独立成卡 */}
          <motion.div variants={fadeUp}>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Icon name="keyboard" size={14} className="text-muted-foreground" />
                  快捷键
                </CardTitle>
                <span className="text-[12px] text-muted-foreground">系统级注册 · 只作用于本实例</span>
              </CardHeader>
              <CardContent className="space-y-4">
                <Alert variant="info">
                  <Icon name="info" size={16} />
                  <AlertDescription className="space-y-1.5">
                    <p>
                      这些键在<b className="font-medium">系统级</b>注册，自动化跑起来、焦点落在目标程序上时依然能按到；
                      它们只作用于<b className="font-medium">本实例</b>。
                    </p>
                    <p>
                      多个实例绑同一个键时，按下只会作用于其中一个（优先当前焦点所在的实例窗口），
                      不会一起生效 —— 想各自独立就改掉重复的键。
                    </p>
                  </AlertDescription>
                </Alert>

                <HotkeyEditor value={hk} onChange={writeHotkeys} conflicts={conflictsOf} />

                <Separator />

                <div className="space-y-2">
                  <div className="text-[12.5px] font-medium text-muted-foreground">窗口内快捷键（不占用系统按键）</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
                      <span className="flex flex-none items-center gap-1">
                        <Kbd>Ctrl</Kbd>
                        <Kbd>S</Kbd>
                      </span>
                      <span className="text-[12.5px] text-muted-foreground">保存当前配置</span>
                    </div>
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
                      <span className="flex flex-none items-center gap-1">
                        <Kbd>/</Kbd>
                      </span>
                      <span className="text-[12.5px] text-muted-foreground">聚焦搜索</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </motion.div>

        <ImagePicker
          open={pickerOpen}
          value={pickerIdx >= 0 ? rules[pickerIdx]?.assetId : undefined}
          onPick={(a) => {
            if (pickerIdx >= 0) updateRule(pickerIdx, { assetId: a.id })
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      </div>
    </Tabs>
  )
}
