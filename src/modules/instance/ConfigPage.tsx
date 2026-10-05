import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ipc, hasRegionPicker } from '@/lib/ipc'
import { ALERT_SOUND_PRESETS, isAudioPath, type AlertSound } from '@/lib/alertSound'
import { SITE_PRESETS, defaultPreset, detectSite, type SiteAdapter } from '@/modules/instance/siteDetect'
import { WindowPicker } from '@/components/blocks/window-picker'
import { PathPicker } from '@/components/blocks/path-picker'
import { baseName, joinPath, outputPathOf, suggestOutputDir } from '@/components/blocks/pathPicker'
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
import { QuickLogiQuery } from '@/modules/instance/QuickLogiQuery'
import { useAssets } from '@/modules/assets/useAssets'
import ImagePicker from '@/modules/assets/ImagePicker'
import { instanceConfigSchema } from '@/schemas/instance'
import { toast } from '@/stores/toastStore'
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

/**
 * 连通性自检。
 *
 * 存在的理由：用户要求"一定要保证能查询到"，但**代码保证不了** ——
 * 密钥没配、单号格式不对、官网改版、撞验证码，任何一条都会失败。
 * 默认表现是跑完整批任务后得到一列"无轨迹"，看不出错在哪一步。
 * 自检花两秒把"卡在哪"直接说出来。
 */
function ProbeButton() {
  const { id = '' } = useParams()
  const inst = useInstanceStore((s) => s.instances[id])
  const [result, setResult] = useState<{
    ok: boolean
    stage: string
    message: string
    missing?: string[]
  } | null>(null)
  // 自检读的是**引擎里已保存的配置**，所以先存一次再探
  const qc = useQueryClient()
  const saveMut = useMutation({
    mutationFn: () => api.saveConfig(id, inst!.config),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instances'] }),
  })
  const probeMut = useMutation({
    mutationFn: () => api.probeLogi(id),
    onSuccess: (r) => {
      setResult(r)
      // 结果同时用 toast 说一句：不熟悉电脑的人不会去读下面那段说明
      if (r.ok) toast.success('通路正常，可以跑整批了')
      else if (r.stage === 'config') toast.info(r.message)
      else toast.error(r.message)
    },
    onError: (e: Error) => {
      setResult({ ok: false, stage: 'query', message: e.message })
      toast.error(e.message)
    },
  })

  const run = () => {
    setResult(null)
    // 未保存的密钥引擎看不到 —— 先落盘再探，否则永远报"没填密钥"
    saveMut.mutate(undefined, {
      onSettled: () => probeMut.mutate(),
    })
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">先自检一次，确认这条路通再跑整批</span>
        <Button
          variant="outline"
          size="sm"
          onClick={run}
          disabled={probeMut.isPending || saveMut.isPending}
        >
          <Icon name="activity" size={13} className={probeMut.isPending ? 'animate-pulse' : undefined} />
          {probeMut.isPending ? '检测中…' : '立即自检'}
        </Button>
      </div>

      {result && (
        <Alert variant={result.ok ? 'success' : result.stage === 'config' ? 'warning' : 'destructive'}>
          <Icon name={result.ok ? 'success' : result.stage === 'config' ? 'warning' : 'error'} size={16} />
          <AlertDescription className="space-y-1 leading-relaxed">
            <div className="font-medium">
              {result.ok ? '通路正常' : result.stage === 'config' ? '配置还没填完（没有发出请求）' : '接口侧的问题'}
            </div>
            <div>{result.message}</div>
            {!!result.missing?.length && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {result.missing.map((m) => (
                  <Badge key={m} variant="warning">
                    缺 {m}
                  </Badge>
                ))}
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
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
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerIdx, setPickerIdx] = useState(-1)
  // 指令序列的摘要要显示素材名而不是 id，所以这里也读一次库（与属性面板共用缓存）
  const { data: assets = [] } = useAssets()

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
      toast.success('配置已保存')
    },
    onError: (e: Error) => toast.error(`保存失败：${e.message}`),
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
      toast.success(`已读取表头：识别到 ${res.columns.length} 列`)
    },
    onError: (e: Error) => toast.error(`上传失败：${e.message}`),
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
  /**
   * 输出文件与输出目录：输出文件是**派生**的（与原文件同名加后缀），
   * 目录默认跟随原文件 —— 用户不需要理解这层规则，也不该手动拼路径。
   */
  const outFile = outputPathOf(logi?.outDir ? joinPath(logi.outDir, baseName(logi.file || '')) : logi?.file || '', '_物流信息')
  const outDirHint = suggestOutputDir(logi?.file || '')
  /** 改单个选择器字段；其余字段原样保留（改一个不该把别的清掉） */
  const setSiteField = (field: keyof NonNullable<LogiConfig['site']>, value: string) =>
    setLogi({
      site: { name: '', url: '', input: '', button: '', result: '', status: '', trace: '', ...(logi?.site ?? {}), [field]: value },
    })
  /** 整组覆盖：预设选择 / 自动识别命中时用 */
  const setSite = (adapter: SiteAdapter) => setLogi({ site: adapter })

  // ── 快递站点：自动识别，不用手填选择器 ──
  const [siteDetectUrl, setSiteDetectUrl] = useState('')
  /** 手动微调区默认收起；自动识别失败或官网改版时才需要 */
  const [showAdapterDetail, setShowAdapterDetail] = useState(false)
  const detect = useMemo(() => detectSite(siteDetectUrl), [siteDetectUrl])

  /**
   * 选了「网页自动化查询」却还没配站点时，直接用默认的快递100 聚合站。
   *
   * 用户最可能的诉求就是"快递可能是多个公司的，来回切换很麻烦"，
   * 让他一进来就面对一堆官网按钮是错的方向 —— 聚合站才是默认答案。
   */
  useEffect(() => {
    if (!logi) return
    if (logi.provider !== 'web') return
    const has = logi.site && !!logi.site.url && !!logi.site.input
    if (has) return
    setLogi({ site: { ...defaultPreset().adapter, company_select: '' } })
  }, [logi?.provider, logi?.site?.url])

  /** 识别成功后一键填入整组选择器；识别不到就什么都不做（UI 上会说明原因） */
  const applyDetect = (url: string) => {
    const r = detectSite(url)
    if (r.kind === 'preset' && r.adapter) {
      setSite(r.aggregate ? { ...r.adapter, company_select: '' } : r.adapter)
    }
  }

  // ── 监控区域：结构化编辑，回写成配置字符串 ──
  const region = parseRegion(monitor?.region)
  const setRegion = (r: MonitorRegion) => patchConfig(id, { region: formatRegion(r) })
  const setRegionField = (patch: Partial<Omit<Extract<MonitorRegion, { kind: 'rect' }>, 'kind'>>) => {
    const base = region.kind === 'rect' ? region : { x: 0, y: 0, width: 800, height: 600 }
    setRegion({ kind: 'rect', ...base, ...patch })
  }

  const rules = monitor?.rules ?? []
  /**
   * 告警声音：monitor 与 guard 都能配（都是"命中即响"的长驻提醒器）。
   * 老存档没有这个字段时兜成默认语音。
   */
  const alertSound: AlertSound =
    (inst.config.tool === 'monitor' || inst.config.tool === 'guard'
      ? inst.config.alertSound
      : null) ?? { preset: 'voice', text: '', customPath: '' }
  const setAlertSound = (patch: Partial<AlertSound>) =>
    patchConfig(id, { alertSound: { ...alertSound, ...patch } } as never)

  const isGuard = inst.config.tool === 'guard'
  const guard = inst.config.tool === 'guard' ? inst.config.guard : null
  /** guard 的绑定窗口在配置根上（与 rpa / macro 同构） */
  const guardWindow = inst.config.tool === 'guard' ? inst.config.window : ''
  const setGuard = (patch: Partial<NonNullable<typeof guard>>) =>
    patchConfig(id, { guard: { ...guard, ...patch } } as never)
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
                        <div className="text-sm text-muted-foreground">
                          当前文件：<span className="text-foreground">{rpa.excelPath || '未选择'}</span>
                        </div>
                        {err('rpa.excelPath') && <p className="text-xs text-destructive">{err('rpa.excelPath')}</p>}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle>列映射</CardTitle>
                        <span className="text-sm text-muted-foreground">下拉项取自 Excel 表头</span>
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
                              <div className="text-base font-medium">启用统一发送内容</div>
                              <div className="mt-0.5 text-sm text-muted-foreground">开启后忽略 Excel「消息内容列」，所有行发同一段内容</div>
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
                          <Field label="每行发送间隔(ms)" hint="发送过快会被目标程序风控/限流">
                            <Input
                              type="number"
                              min={0}
                              max={10000}
                              value={rpa.sendIntervalMs ?? 500}
                              onChange={(e) => setRpa({ sendIntervalMs: e.target.value === '' ? 0 : Number(e.target.value) })}
                            />
                          </Field>
                        </div>
                        <Separator />
                        <div className="flex flex-wrap gap-x-7 gap-y-3">
                          <span className="flex items-center gap-2 text-base">
                            <Switch checked={rpa.skipSuccess} onCheckedChange={(v) => setRpa({ skipSuccess: v })} />
                            跳过已「成功」的行
                          </span>
                          <span className="flex items-center gap-2 text-base">
                            <Switch checked={rpa.writeReason} onCheckedChange={(v) => setRpa({ writeReason: v })} />
                            回写失败原因
                          </span>
                          <span className="flex items-center gap-2 text-base">
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
                        <WindowPicker
                          value={inst.config.tool === 'rpa' ? inst.config.window : ''}
                          onChange={(v) => patchConfig(id, { window: v })}
                          error={err('window')}
                        />
                        <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">
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
                {/* 主路径：贴单号就查。Excel 批量是下面那张卡的进阶用法 */}
                <QuickLogiQuery id={id} name={inst.name} />

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
                    <Badge variant="secondary">三种都无需申请接口也能用</Badge>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      {(
                        [
                          ['excel', '① Excel 匹配合并', '用平台导出的物流表按单号合并，纯本地最快最稳'],
                          ['web', '② 网页自动化查询', '自动识别快递站点，逐个单号开网页读取轨迹'],
                          ['api', '③ 快递100 接口', '最稳的一条：不受官网页面改版与验证码影响，需申请密钥'],
                        ] as Array<[LogiConfig['provider'], string, string]>
                      ).map(([key, title, desc]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setLogi({ provider: key })}
                          className={`rounded-lg border p-3 text-left transition-colors ${
                            logi.provider === key
                              ? 'border-primary bg-primary/[0.06] ring-1 ring-primary/20'
                              : 'border-border hover:border-primary/50 hover:bg-accent/40'
                          }`}
                        >
                          <div className="text-base font-medium">{title}</div>
                          <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</div>
                        </button>
                      ))}
                    </div>
                    <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">
                      原文件保持只读，查询结果写入新文件；已查过的单号进本地缓存，不重复查询
                    </div>
                  </CardContent>
                </Card>

                {/* ③ 快递100 接口：唯一不受官网页面影响的路，密钥必填 */}
                {logi.provider === 'api' && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Icon name="shield" size={14} className="text-muted-foreground" />
                        快递100 接口
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <Alert variant="info">
                        <Icon name="info" size={16} />
                        <AlertDescription className="leading-relaxed">
                          这是最不容易失败的一种方式：官网页面改版、加验证码都不影响它。
                          到 <b className="font-medium">kuaidi100.com</b> 注册后，在「我的信息」里拿到
                          <b className="font-medium">客户号(CustomerKey)</b> 和
                          <b className="font-medium">密钥</b>，填到下面两栏即可。
                          免费版每天有查询次数上限，超出要付费。
                        </AlertDescription>
                      </Alert>

                      <Field label="客户号 CustomerKey" required hint="在快递100「我的信息」页面，密钥那一栏附近">
                        <Input
                          className="h-8 font-mono text-sm"
                          placeholder="例如 12345678"
                          value={logi.customer}
                          onChange={(e) => setLogi({ customer: e.target.value })}
                        />
                      </Field>

                      <Field
                        label="接口密钥"
                        required
                        hint="同页面获取。密钥只参与签名计算，不会明文发出去"
                        error={
                          logi.customer.trim() && !logi.apiKey.trim() ? '选了接口查询就要填密钥，否则一定查不到' : undefined
                        }
                      >
                        <Input
                          className="h-8 font-mono text-sm"
                          type="password"
                          placeholder="填写快递100 提供的密钥"
                          value={logi.apiKey}
                          onChange={(e) => setLogi({ apiKey: e.target.value })}
                          error={!!logi.customer.trim() && !logi.apiKey.trim()}
                        />
                      </Field>

                      <ProbeButton />
                    </CardContent>
                  </Card>
                )}

                {logi.provider === 'web' && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Icon name="wand" size={14} className="text-muted-foreground" />
                        查询站点
                      </CardTitle>
                      {logi.site?.name && <Badge variant="secondary">{logi.site.name}</Badge>}
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* ① 首选：贴网址自动认站点。用户只需要复制查询页地址，
                          不需要知道什么是 CSS 选择器。 */}
                      <Field
                        label="查询页网址"
                        hint="粘贴快递官网的查询页地址，系统会自动识别是哪家快递并填好配置"
                      >
                        <div className="flex items-center gap-2">
                          <Input
                            className="h-8 flex-1 font-mono text-sm"
                            placeholder="https://www.sf-express.com/chn/sc/dynamic_function/waybill/"
                            value={siteDetectUrl}
                            onChange={(e) => setSiteDetectUrl(e.target.value)}
                            onBlur={() => applyDetect(siteDetectUrl)}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => applyDetect(siteDetectUrl)}
                            disabled={!siteDetectUrl.trim()}
                          >
                            <Icon name="wand" size={13} />
                            自动识别
                          </Button>
                        </div>
                      </Field>

                      {/* ② 识别结果：说明可信度，而不是默默填一堆值 */}
                      {detect.kind === 'preset' && (
                        <div className="flex items-start gap-2 rounded-lg border border-ok/35 bg-ok/8 px-3 py-2.5">
                          <Icon name="success" size={15} className="mt-0.5 flex-none text-ok" />
                          <div className="min-w-0 text-sm leading-relaxed">
                            <div className="font-medium">
                              已自动填入「{detect.preset.name}」的查询配置
                            </div>
                            <div className="mt-0.5 text-muted-foreground">
                              {detect.source === 'url'
                                ? '按网址域名精确匹配，配置可信。'
                                : '按快递公司名匹配，请点下方「查看细节」核对一遍。'}
                              {detect.source === 'carrier' && (
                                <button
                                  type="button"
                                  className="ml-1 text-primary underline-offset-2 hover:underline"
                                  onClick={() => setShowAdapterDetail((v) => !v)}
                                >
                                  {showAdapterDetail ? '收起细节' : '查看细节'}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                      {detect.kind === 'unknown' && (
                        <div className="flex items-start gap-2 rounded-lg border border-warn/35 bg-warn/8 px-3 py-2.5">
                          <Icon name="warning" size={15} className="mt-0.5 flex-none text-warn" />
                          <div className="min-w-0 text-sm leading-relaxed">
                            <div className="font-medium">没能自动识别这个站点</div>
                            <div className="mt-0.5 text-muted-foreground">{detect.hint}</div>
                          </div>
                        </div>
                      )}

                      {/* ③ 兜底：从预设列表里直接选。
                          聚合站排在最前并单独标注 —— 用户最怕的就是"快递公司不一样要来回切" */}
                      <Field
                        label="选择查询站点"
                        hint="首选快递100 聚合：一个入口查所有快递公司，自动识别归属，不用为每家单独配"
                      >
                        <div className="space-y-2">
                          {SITE_PRESETS.filter((p) => p.aggregate).map((p) => (
                            <button
                              key={p.name}
                              type="button"
                              onClick={() => setSite({ ...p.adapter, company_select: '' })}
                              className={cn(
                                'flex w-full items-start gap-2.5 rounded-lg border p-3 text-left transition-colors',
                                logi.site?.name === p.adapter.name
                                  ? 'border-primary bg-primary/[0.06] ring-1 ring-primary/20'
                                  : 'border-border hover:border-primary/50 hover:bg-accent/40',
                              )}
                            >
                              <Icon
                                name="check"
                                size={15}
                                className={cn(
                                  'mt-0.5 flex-none',
                                  logi.site?.name === p.adapter.name ? 'text-primary' : 'text-muted-foreground/50',
                                )}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-2">
                                  <span className="text-base font-medium">{p.name}</span>
                                  <Badge variant="success">推荐</Badge>
                                </span>
                                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                                  {p.note}
                                </span>
                              </span>
                            </button>
                          ))}

                          <div className="pt-1 text-xs text-muted-foreground">
                            聚合站查不到时，可改用快递公司官网直查（只支持该家单号）：
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {SITE_PRESETS.filter((p) => !p.aggregate).map((p) => (
                              <Button
                                key={p.name}
                                variant={logi.site?.name === p.adapter.name ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setSite(p.adapter)}
                              >
                                {p.name}
                              </Button>
                            ))}
                          </div>
                        </div>
                      </Field>

                      <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
                        <span className="text-sm text-muted-foreground">遇验证码自动暂停，转人工处理</span>
                        <Switch
                          checked={logi.pauseOnCaptcha ?? true}
                          onCheckedChange={(v) => setLogi({ pauseOnCaptcha: v })}
                        />
                      </div>

                      {/* ④ 手动兜底：默认收起。认不出站点、或官网改版时才需要动这里。 */}
                      <details
                        className="rounded-lg border border-border"
                        open={showAdapterDetail || logi.provider === 'web' ? undefined : false}
                        onToggle={(e) => setShowAdapterDetail((e.currentTarget as HTMLDetailsElement).open)}
                      >
                        <summary className="cursor-pointer select-none px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
                          手动微调选择器（官网改版或自动识别不准时才用）
                        </summary>
                        <div className="space-y-3 border-t border-border p-3">
                          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                            选择器是网页元素的定位方式（类似 <code>#waybill-no</code>、<code>.track-result</code>）。
                            正常情况下上面选好快递公司就够了，这里留给需要微调的情况。
                          </div>
                          <SiteField label="适配器名称" value={logi.site?.name ?? ''} onChange={(v) => setSiteField('name', v)} placeholder="如 顺丰官网" />
                          <SiteField label="查询页 URL" value={logi.site?.url ?? ''} onChange={(v) => setSiteField('url', v)} placeholder="https://www.example.com/track" />
                          <SiteField label="单号输入框选择器" value={logi.site?.input ?? ''} onChange={(v) => setSiteField('input', v)} placeholder="如 #waybill-no" />
                          <SiteField label="查询按钮选择器" value={logi.site?.button ?? ''} onChange={(v) => setSiteField('button', v)} placeholder="如 #search-btn" />
                          <SiteField label="结果容器选择器" value={logi.site?.result ?? ''} onChange={(v) => setSiteField('result', v)} placeholder="如 .track-result" />
                          <SiteField label="状态文本选择器" value={logi.site?.status ?? ''} onChange={(v) => setSiteField('status', v)} placeholder="如 .status-text" />
                          <SiteField label="轨迹文本选择器" value={logi.site?.trace ?? ''} onChange={(v) => setSiteField('trace', v)} placeholder="如 .trace-list" />
                        </div>
                      </details>
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
                      <Input readOnly value={outFile || '（上传后自动生成）'} />
                    </Field>

                    <Field
                      label="输出目录"
                      hint="默认与原文件同目录；放到别处就改这里，留空表示跟随原文件"
                    >
                      <PathPicker
                        mode="dir"
                        value={logi.outDir ?? ''}
                        placeholder={outDirHint || '与原文件同目录'}
                        onChange={(v) => setLogi({ outDir: v })}
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

                    <div className="text-sm text-muted-foreground">
                      只会在选定范围内查找目标图，范围越小误报越少；坐标为屏幕物理像素。
                    </div>
                  </CardContent>
                </Card>

                {/* 告警声音：每个实例单独一套，嘈杂环境靠声音分辨是哪个实例在报 */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Icon name="bell" size={14} className="text-muted-foreground" />
                      告警声音
                    </CardTitle>
                    <span className="text-xs text-muted-foreground">仅本实例生效</span>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Field label="提示音" hint="同时盯多个会话时，用不同声音分辨是哪个实例在报警">
                      <div className="flex flex-wrap gap-1.5">
                        {ALERT_SOUND_PRESETS.map((p) => (
                          <Button
                            key={p.id}
                            variant={alertSound.preset === p.id ? 'default' : 'outline'}
                            size="sm"
                            title={p.hint}
                            onClick={() => setAlertSound({ preset: p.id, customPath: '' })}
                          >
                            {p.label}
                          </Button>
                        ))}
                      </div>
                    </Field>

                    {alertSound.preset === 'voice' && (
                      <Field label="播报文案" hint="支持 {客户名} 之类的占位符会由引擎替换；留空用默认文案">
                        <Input
                          className="h-8"
                          placeholder="例如：有新的客户消息，请注意查收"
                          value={alertSound.text}
                          onChange={(e) => setAlertSound({ text: e.target.value })}
                        />
                      </Field>
                    )}

                    <Field
                      label="自定义音频"
                      hint="用自己的铃声更醒目。填 .wav / .mp3 的完整路径；填了就以上面的选择为准"
                    >
                      <div className="flex items-center gap-2">
                        <Input
                          className="h-8 flex-1 font-mono text-sm"
                          placeholder="C:/Sounds/ding.wav"
                          value={alertSound.customPath}
                          onChange={(e) => setAlertSound({ customPath: e.target.value })}
                          error={alertSound.customPath.trim() !== '' && !isAudioPath(alertSound.customPath)}
                        />
                        {alertSound.customPath && (
                          <Button variant="ghost" size="sm" onClick={() => setAlertSound({ customPath: '' })}>
                            <Icon name="close" size={13} />
                            清除
                          </Button>
                        )}
                      </div>
                    </Field>

                    {alertSound.customPath.trim() !== '' && !isAudioPath(alertSound.customPath) && (
                      <Alert variant="warning">
                        <Icon name="warning" size={16} />
                        <AlertDescription>只支持 .wav / .mp3 音频文件，这个路径播不出来。</AlertDescription>
                      </Alert>
                    )}
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
                          <span className="w-12 text-right font-mono text-sm tabular-nums">{r.threshold.toFixed(2)}</span>
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
                  <CardContent className="space-y-2 text-base leading-relaxed text-muted-foreground">
                    <p>复用 notic 的 OpenCV 模板匹配内核：持续抓屏，对每张目标图做多尺度匹配。</p>
                    <p>相似度达到阈值即记为一次命中，写入运行日志与命中记录，画面持续存在只报一次。</p>
                    <p>参考图直接复用图像素材库，删除素材会一并失效该规则。</p>
                  </CardContent>
                </Card>
              </div>
            </motion.div>
          )}

          {/* ④ 敏感词监控：绑定窗口 + 抓取方式 + 危级 + 声音 */}
          {isGuard && guard && (
            <TabsContent value="data" className="mt-0">
              <motion.div variants={fadeUp} className="grid grid-cols-12 gap-4">
                <div className="col-span-12 lg:col-span-7">
                  <Card>
                    <CardHeader>
                      <CardTitle>绑定窗口</CardTitle>
                      <span className="text-xs text-muted-foreground">决定盯哪个输入框</span>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <WindowPicker
                        value={guardWindow}
                        onChange={(v) => patchConfig(id, { window: v })}
                        error={err('window')}
                      />
                      <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">
                        监控的是**输入框里正在编辑、尚未发送的内容** —— 客服打出来、发出去之前就会拦下。
                        没绑定窗口时整轮直接失败：在不知道是哪个窗口的情况下扫描，等于乱报。
                      </div>
                    </CardContent>
                  </Card>

                  {/* 抓取方式：这是自绘软件能不能用的关键，必须让用户看见 */}
                  <Card className="mt-4">
                    <CardHeader>
                      <CardTitle>读取方式</CardTitle>
                      <Badge variant="warning">自绘软件需降级</Badge>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                        {(
                          [
                            ['auto', '自动（推荐）', '先读界面控件，读不到就降级读剪贴板'],
                            ['uia', '只读界面控件', '更精准，但自绘软件可能读不到'],
                            ['clipboard', '只读剪贴板', '覆盖自绘软件，只在客户发送后才有记录'],
                          ] as const
                        ).map(([key, title, desc]) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setGuard({ captureMode: key })}
                            className={`rounded-lg border p-3 text-left transition-colors ${
                              guard.captureMode === key
                                ? 'border-primary bg-primary/[0.06] ring-1 ring-primary/20'
                                : 'border-border hover:border-primary/50 hover:bg-accent/40'
                            }`}
                          >
                            <div className="text-base font-medium">{title}</div>
                            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</div>
                          </button>
                        ))}
                      </div>

                      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/50 p-3">
                        <div className="min-w-0">
                          <div className="text-sm">允许降级为读取剪贴板</div>
                          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                            京麦 / 钉钉 / 飞鸽这类自绘软件不暴露标准界面控件，关掉这一项这些软件就完全读不到。
                            读取剪贴板是敏感操作，所以默认开着但明确列出来，由你决定。
                          </div>
                        </div>
                        <Switch
                          checked={guard.allowClipboard}
                          onCheckedChange={(v) => setGuard({ allowClipboard: v })}
                        />
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <div className="col-span-12 lg:col-span-5">
                  {/* 危级：先只开高危是更稳的做法 */}
                  <Card>
                    <CardHeader>
                      <CardTitle>告警级别</CardTitle>
                      <Badge variant="secondary">
                        {guard.levels.length === 3 ? '全部' : `${guard.levels.length} 档`}
                      </Badge>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {(
                        [
                          ['high', '高危', '加微信、私下交易 — 建议一开始就开'],
                          ['mid', '中危', '绝对化承诺、推诿话术'],
                          ['low', '低危', '「最」这类用词 — 全开容易疲劳'],
                        ] as const
                      ).map(([k, label, desc]) => {
                        const on = guard.levels.includes(k)
                        return (
                          <button
                            key={k}
                            type="button"
                            onClick={() =>
                              setGuard({
                                levels: on ? guard.levels.filter((x) => x !== k) : [...guard.levels, k],
                              })
                            }
                            className={`flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors ${
                              on ? 'border-primary bg-primary/[0.05]' : 'border-border hover:bg-accent/40'
                            }`}
                          >
                            <span
                              className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
                                on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50'
                              }`}
                            >
                              {on && <Icon name="check" size={11} />}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">{label}</span>
                              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                                {desc}
                              </span>
                            </span>
                          </button>
                        )
                      })}

                      <Field label="轮询间隔（ms）" hint="太密会拖慢客服打字，建议 800 以上">
                        <Input
                          className="h-8"
                          type="number"
                          min={300}
                          max={10000}
                          value={guard.pollMs}
                          onChange={(e) => setGuard({ pollMs: Number(e.target.value) || 800 })}
                        />
                      </Field>

                      <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">
                        同一句话在两分钟内只报一次：客服打字过程中会连续多轮读到同一段文字。
                      </div>
                    </CardContent>
                  </Card>

                  {/* 告警声音：与图片监控同一套（每个实例独立） */}
                  <Card className="mt-4">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Icon name="bell" size={14} className="text-muted-foreground" />
                        告警声音
                      </CardTitle>
                      <span className="text-xs text-muted-foreground">仅本实例生效</span>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <Field label="提示音" hint="同时盯多个会话时，用不同声音分辨是哪个实例在报警">
                        <div className="flex flex-wrap gap-1.5">
                          {ALERT_SOUND_PRESETS.map((p) => (
                            <Button
                              key={p.id}
                              variant={alertSound.preset === p.id ? 'default' : 'outline'}
                              size="sm"
                              title={p.hint}
                              onClick={() => setAlertSound({ preset: p.id, customPath: '' })}
                            >
                              {p.label}
                            </Button>
                          ))}
                        </div>
                      </Field>
                      {alertSound.preset === 'voice' && (
                        <Field label="播报文案" hint="留空用默认文案">
                          <Input
                            className="h-8"
                            placeholder="例如：注意，有高危敏感词"
                            value={alertSound.text}
                            onChange={(e) => setAlertSound({ text: e.target.value })}
                          />
                        </Field>
                      )}
                      <Field label="自定义音频" hint="填 .wav / .mp3 的完整路径，填了就以上面的选择为准">
                        <Input
                          className="h-8 font-mono text-sm"
                          placeholder="C:/Sounds/alert.wav"
                          value={alertSound.customPath}
                          onChange={(e) => setAlertSound({ customPath: e.target.value })}
                          error={alertSound.customPath.trim() !== '' && !isAudioPath(alertSound.customPath)}
                        />
                      </Field>
                    </CardContent>
                  </Card>
                </div>
              </motion.div>
            </TabsContent>
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
                        <WindowPicker
                          value={macroWindow}
                          onChange={(v) => patchConfig(id, { window: v })}
                          error={err('window')}
                        />
                        <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">
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
                      <CardContent className="space-y-3 text-base leading-relaxed text-muted-foreground">
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
                <span className="text-sm text-muted-foreground">系统级注册 · 只作用于本实例</span>
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
                  <div className="text-sm font-medium text-muted-foreground">窗口内快捷键（不占用系统按键）</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
                      <span className="flex flex-none items-center gap-1">
                        <Kbd>Ctrl</Kbd>
                        <Kbd>S</Kbd>
                      </span>
                      <span className="text-sm text-muted-foreground">保存当前配置</span>
                    </div>
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
                      <span className="flex flex-none items-center gap-1">
                        <Kbd>/</Kbd>
                      </span>
                      <span className="text-sm text-muted-foreground">聚焦搜索</span>
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
