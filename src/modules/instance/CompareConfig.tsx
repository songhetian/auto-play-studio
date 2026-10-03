import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { api } from '@/lib/api'
import { useInstanceStore } from '@/stores/instanceStore'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Icon } from '@/components/icon'
import { Dropzone } from '@/components/Dropzone'
import { EmptyState } from '@/components/blocks/empty-state'
import { Field } from '@/components/blocks/field'
import { fadeItem, fadeUp, staggerList } from '@/lib/motion'
import type { CmpConfig, CompareField, InstanceConfig } from '@/schemas/instance'

const NUM_HINT = ['金额', '数量', '差额', '价格', '费用']

/** Radix Select 不允许空字符串作为选项值，用哨兵值表示「不比对」，回写时再落成 null */
const NO_MAP = '__none__'

/** 从列名猜一下要不要按数值比：省得每个字段都手点一遍 */
function guessType(name: string): CompareField['type'] {
  return NUM_HINT.some((h) => name.includes(h)) ? 'number' : 'text'
}

export default function CompareConfig({ id }: { id: string }) {
  const qc = useQueryClient()
  const inst = useInstanceStore((s) => s.instances[id])
  const cfg: CmpConfig | null = inst?.config.tool === 'cmp' ? inst.config.cmp : null

  const [fields, setFields] = useState<CompareField[]>([])
  const [tolerance, setTolerance] = useState(0)
  const [maps, setMaps] = useState<Record<string, Record<string, string | null>>>({})
  const seeded = useRef<string>('')

  // 只有换了 A 表才重新播种，否则会把用户正在改的角色/映射冲掉
  useEffect(() => {
    if (!cfg) return
    const sig = cfg.primaryFile || ''
    if (seeded.current === sig) return
    seeded.current = sig
    setFields((cfg.primaryFields ?? []).map((f) => ({ ...f, type: f.type || guessType(f.name) })))
    setTolerance(cfg.tolerance ?? 0)
    setMaps(cfg.maps ?? {})
  }, [cfg])

  const tables = cfg?.tables ?? {}
  const tableNames = Object.keys(tables)
  const keyCount = fields.filter((f) => f.role === 'key').length
  const ready = !!cfg?.primaryFile && keyCount > 0 && fields.some((f) => f.role === 'compare')

  const uploadMut = useMutation({
    mutationFn: ({ role, file }: { role: 'primary' | 'other'; file: File }) => api.uploadCompareTable(id, role, file),
    onSuccess: async (table, vars) => {
      await qc.invalidateQueries({ queryKey: ['instances'] })
      if (vars.role === 'other') {
        const res = await api.autoMap(id, table.name)
        setMaps(res.maps)
        await qc.invalidateQueries({ queryKey: ['instances'] })
      }
    },
  })

  const removeTableMut = useMutation({
    mutationFn: (name: string) =>
      fetch(`/api/instances/${id}/compare/table?name=${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instances'] }),
  })

  const autoMapMut = useMutation({
    mutationFn: () => api.autoMap(id),
    onSuccess: (res) => setMaps(res.maps),
  })

  const saveMut = useMutation({
    mutationFn: () =>
      api.saveConfig(id, {
        // 用 Extract 精确收窄，hotkeys 这类实例级字段才会一起带过去
        ...(inst!.config as Extract<InstanceConfig, { tool: 'cmp' }>),
        cmp: { ...cfg!, primaryFields: fields, tolerance, maps },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instances'] }),
  })

  // ── 方案（全局库）：存的是「字段角色 + 列映射 + 容差」，换实例、换批文件都能套 ──
  const { data: plans = [] } = useQuery({ queryKey: ['plans', 'cmp'], queryFn: () => api.listPlans('cmp') })
  const [planName, setPlanName] = useState('')
  const [pickedPlan, setPickedPlan] = useState('')

  const savePlanMut = useMutation({
    mutationFn: (name: string) => api.savePlan(id, name),
    onSuccess: () => {
      setPlanName('')
      qc.invalidateQueries({ queryKey: ['plans'] })
    },
  })

  const applyPlanMut = useMutation({
    mutationFn: (planId: string) => api.applyPlan(id, planId),
    onSuccess: () => {
      // 播种以「A 表变了」为信号，而载入方案并不换文件 ——
      // 不把种子清掉，界面上会一直显示载入前的旧角色
      seeded.current = ''
      qc.invalidateQueries({ queryKey: ['instances'] })
    },
  })

  if (!inst || !cfg) {
    return (
      <EmptyState
        className="h-full"
        icon="error"
        title="实例不存在或已被删除"
        desc="它可能已经在这个窗口之外被删掉了，回控制台的实例管理里确认一下。"
      />
    )
  }

  const setRole = (name: string, role: CompareField['role']) =>
    setFields((prev) => prev.map((f) => (f.name === name ? { ...f, role } : f)))

  const setType = (name: string, type: CompareField['type']) =>
    setFields((prev) => prev.map((f) => (f.name === name ? { ...f, type } : f)))

  const setMap = (table: string, field: string, col: string) =>
    setMaps((prev) => ({ ...prev, [table]: { ...(prev[table] ?? {}), [field]: col || null } }))

  const primaryName = cfg.primaryFile.split(/[\\/]/).pop() || '未选择'

  return (
    <div className="space-y-4">
      <motion.div variants={fadeUp} initial="hidden" animate="show" className="flex flex-wrap items-center gap-3">
        <Badge variant="secondary" className="font-mono">
          {inst.id}
        </Badge>
        <span className="text-[12px] text-muted-foreground">
          以 A 表为基准，逐行与 B/C 表核对；列名不同也能靠智能匹配对上
        </span>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => autoMapMut.mutate()}
          disabled={!cfg.primaryFile || autoMapMut.isPending}
        >
          <Icon name="wand" size={13} />
          {autoMapMut.isPending ? '匹配中…' : '重新智能匹配'}
        </Button>
        <Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
          <Icon name="check" size={13} />
          保存配置
        </Button>
      </motion.div>

      <motion.div variants={staggerList} initial="hidden" animate="show" className="grid grid-cols-12 gap-4">
        <motion.div variants={fadeItem} className="col-span-12 space-y-4 lg:col-span-8">
          <Card>
            <CardHeader>
              <CardTitle>A 表（基准表）</CardTitle>
              <span className="text-[12px] text-muted-foreground">所有行以它为准</span>
            </CardHeader>
            <CardContent>
              <Dropzone
                accept=".xlsx,.xlsm"
                onFile={(f) => uploadMut.mutate({ role: 'primary', file: f })}
                hint="上传后自动识别列名，并为每列猜一个字段类型"
              />
              <div className="mt-3 text-[12px] text-muted-foreground">
                当前文件：<span className="font-medium text-foreground">{primaryName}</span>
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>字段角色与列映射</CardTitle>
              <span className="text-[12px] text-muted-foreground">
                主键 {keyCount} 个 · 对比 {fields.length - keyCount} 个
              </span>
            </CardHeader>

            {!fields.length ? (
              <EmptyState
                icon="sheet"
                title="还没有可配置的字段"
                desc="先上传上面的 A 表（基准表），系统识别列名后会在这里列出每一列，让你指定主键与对比项。"
              />
            ) : (
              <Table style={{ minWidth: 560 + tableNames.length * 180 }}>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[160px]">A 表字段</TableHead>
                    <TableHead className="w-[150px]">角色</TableHead>
                    <TableHead className="w-[120px]">类型</TableHead>
                    {tableNames.map((t) => (
                      <TableHead key={t} className="min-w-[180px]">
                        {t}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fields.map((f) => (
                    <TableRow key={f.name}>
                      <TableCell className="font-medium">{f.name}</TableCell>
                      <TableCell>
                        <Select value={f.role} onValueChange={(v) => setRole(f.name, v as CompareField['role'])}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="key">主键（匹配行）</SelectItem>
                            <SelectItem value="compare">对比</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select value={f.type} onValueChange={(v) => setType(f.name, v as CompareField['type'])}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="text">文本</SelectItem>
                            <SelectItem value="number">数值</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      {tableNames.map((t) => {
                        const col = maps[t]?.[f.name] ?? ''
                        const matched = !!col
                        return (
                          <TableCell key={t}>
                            <Select value={col || NO_MAP} onValueChange={(v) => setMap(t, f.name, v === NO_MAP ? '' : v)}>
                              <SelectTrigger className={matched ? undefined : '!border-[hsl(var(--warn)/0.6)]'}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NO_MAP}>（不比对）</SelectItem>
                                {tables[t].columns.map((c) => (
                                  <SelectItem key={c} value={c}>
                                    {c}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {!!fields.length && keyCount === 0 && (
              <div className="px-5 py-4">
                <Alert variant="destructive">
                  <Icon name="warning" size={16} />
                  <AlertDescription>至少要指定一个主键字段（用于匹配行，如订单号）</AlertDescription>
                </Alert>
              </div>
            )}
          </Card>
        </motion.div>

        <motion.div variants={fadeItem} className="col-span-12 space-y-4 lg:col-span-4">
          <Card>
            <CardHeader>
              <CardTitle>对比表（B / C…）</CardTitle>
              {tableNames.length ? <Badge variant="secondary">{tableNames.length} 张</Badge> : null}
            </CardHeader>
            <CardContent className="space-y-3">
              <Dropzone
                accept=".xlsx,.xlsm"
                onFile={(f) => uploadMut.mutate({ role: 'other', file: f })}
                hint="可反复添加多张"
              />
              {tableNames.map((t) => (
                <div key={t} className="flex items-center gap-2 border-b border-border py-2 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px]">{t}</div>
                    <div className="text-[11.5px] text-muted-foreground">{tables[t].columns.length} 列</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removeTableMut.mutate(t)}
                  >
                    <Icon name="trash" size={13} />
                    移除
                  </Button>
                </div>
              ))}
              {!tableNames.length && <div className="text-[12.5px] text-muted-foreground">还没有对比表</div>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>比对规则</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="数值容差" hint="差额绝对值不超过容差即视为一致">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={tolerance}
                  onChange={(e) => setTolerance(Number(e.target.value) || 0)}
                />
              </Field>
              <div className="space-y-1.5 border-t border-border pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
                <div>
                  · 主键命中但在对比表里找不到 → <span className="font-medium text-foreground">缺失</span>
                </div>
                <div>
                  · 只在对比表里出现 → <span className="font-medium text-foreground">多余</span>
                </div>
                <div>
                  · 数值列填了非数字 → <span className="font-medium text-foreground">数据错误</span>
                </div>
                <div>· 整体结论取最严重的一项</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>方案</CardTitle>
              <span className="text-[12px] text-muted-foreground">存进全局库，别的实例也能用</span>
            </CardHeader>
            <CardContent className="space-y-3">
              {!cfg?.primaryFile ? (
                <p className="text-[12px] text-muted-foreground">先上传 A 表（基准表），才能存方案或载入方案。</p>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label>载入方案</Label>
                    <div className="flex gap-2">
                      <Select value={pickedPlan} onValueChange={setPickedPlan}>
                        <SelectTrigger className="flex-1">
                          <SelectValue placeholder={plans.length ? '选择一个方案' : '还没有存过方案'} />
                        </SelectTrigger>
                        <SelectContent>
                          {plans.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!pickedPlan || applyPlanMut.isPending}
                        onClick={() => applyPlanMut.mutate(pickedPlan)}
                      >
                        {applyPlanMut.isPending ? '载入中…' : '载入'}
                      </Button>
                    </div>
                    <p className="text-[11.5px] text-muted-foreground">
                      按主表名匹配：换成另一张 A 表时方案不生效，免得容差这类口径张冠李戴。
                    </p>
                  </div>

                  <div className="space-y-1.5 border-t border-border pt-3">
                    <Label>另存为方案</Label>
                    <div className="flex gap-2">
                      <Input
                        value={planName}
                        onChange={(e) => setPlanName(e.target.value)}
                        placeholder="方案名，如：日对账"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!planName.trim() || savePlanMut.isPending}
                        onClick={() => savePlanMut.mutate(planName.trim())}
                      >
                        {savePlanMut.isPending ? '保存中…' : '保存'}
                      </Button>
                    </div>
                  </div>
                </>
              )}

              {(savePlanMut.isSuccess || applyPlanMut.isSuccess) && (
                <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <Icon name="check" size={12} />
                  {savePlanMut.isSuccess ? `已保存为「${savePlanMut.data.name}」` : `已载入「${applyPlanMut.data?.name}」`}
                </div>
              )}
              {(savePlanMut.isError || applyPlanMut.isError) && (
                <Alert variant="destructive">
                  <Icon name="error" size={16} />
                  <AlertDescription>
                    {((savePlanMut.error ?? applyPlanMut.error) as Error).message}
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>执行</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Alert variant={ready ? 'success' : 'warning'}>
                <Icon name={ready ? 'success' : 'warning'} size={16} />
                <AlertDescription>
                  {ready ? '配置已就绪，可以执行对比' : '还需要：A 表 + 至少一个主键 + 至少一个对比字段'}
                </AlertDescription>
              </Alert>
              <p className="text-[12px] text-muted-foreground">
                执行请到「运行详情」页 —— 配置页只改数据，不触发运行。
              </p>
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>
    </div>
  )
}
