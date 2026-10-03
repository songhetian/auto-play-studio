import { useState } from 'react'
import { api } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Icon } from '@/components/icon'
import { EmptyState } from '@/components/blocks/empty-state'
import { Field } from '@/components/blocks/field'
import { TemplatePreview } from '@/components/blocks/template-preview'
import { KeyPicker } from '@/components/blocks/key-picker'
import { comboLabel } from '@/lib/keys'
import type { Cmd } from '@/schemas/instance'
import ImagePicker from '@/modules/assets/ImagePicker'
import { useAssets } from '@/modules/assets/useAssets'

const TYPE_LABEL: Record<Cmd['type'], string> = {
  win: '窗口',
  text: '文本',
  key: '按键',
  mouse: '鼠标',
  img: '图像',
  flow: '流程',
}

/** 属性面板：逐项编辑当前选中指令的参数，改完直接进 store */
export default function CmdInspector({
  cmd,
  cmdIndex,
  variables,
  columns,
  sample,
  excelPath,
  hasDataSource,
  onChange,
  onRemove,
}: {
  cmd: Cmd | null
  /** 这条指令在序列里的下标：仅用作 React key，换指令时把拾取器的草稿状态重置掉 */
  cmdIndex: number
  /** 可插入的变量，来自当前实例的列映射 */
  variables: string[]
  /** 可用列名，预览要用它判断哪个占位符是错的；空数组＝还没上传 Excel */
  columns: string[]
  /** 上传时抓下来的真值行，预览拿它渲染 */
  sample: { row_no: number; key: string; values: Record<string, unknown> } | undefined
  /** 上传的 Excel 路径。宏没有数据源，不传 */
  excelPath?: string
  /**
   * 这个实例是否有数据源（`rpa` 有，`macro` 没有）。
   *
   * 为 false 时**不显示模板预览与变量按钮**：宏没有列，预览里那句「上传 Excel 后
   * 可在这里看到渲染效果」是做不到的承诺，而 `{列名}` 在宏里取不到值只会让这一步失败。
   */
  hasDataSource: boolean
  onChange: (patch: Partial<Cmd>) => void
  onRemove: () => void
}) {
  const [picking, setPicking] = useState(false)
  // 只有图像指令才需要读素材库，别的指令类型不白跑这个查询
  const { data: assets = [], isLoading: assetsLoading } = useAssets(cmd?.type === 'img')

  if (!cmd) {
    return (
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>属性</CardTitle>
        </CardHeader>
        <EmptyState icon="sliders" title="未选择指令" desc="在指令序列里点一条，即可在这里编辑它的参数" />
      </Card>
    )
  }

  const key = cmd.key ?? { combo: [], delayMs: 120, repeat: 1 }
  const image = cmd.image ?? { threshold: 0.85, timeoutSec: 5, offsetX: 0, offsetY: 0, onMiss: 'fail' as const }
  const asset = image.assetId ? assets.find((a) => a.id === image.assetId) : undefined
  /** assetId 有值但库里找不到 —— 素材被强删或文件没同步过来（等查询回来再下结论） */
  const assetMissing = !!image.assetId && !asset && !assetsLoading

  const setKey = (patch: Partial<typeof key>) => onChange({ key: { ...key, ...patch } })
  const setImage = (patch: Partial<typeof image>) => onChange({ image: { ...image, ...patch } })

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>属性</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{TYPE_LABEL[cmd.type]}</Badge>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onRemove}>
            <Icon name="trash" size={13} />
            删除
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium">{cmd.t}</div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">关掉后这一条不执行，但仍留在序列里</div>
          </div>
          <Switch checked={cmd.on} onCheckedChange={(v) => onChange({ on: v })} />
        </div>

        {cmd.type === 'win' && (
          <div className="space-y-3">
            <Field
              label="窗口标题（可含关键字）"
              hint={hasDataSource ? '留空则用本行关键字当窗口标题' : '宏没有数据源，这里必须写清楚要切到哪个窗口'}
            >
              <Input value={cmd.p} placeholder="例如 微信 / 企业微信" onChange={(e) => onChange({ p: e.target.value })} />
            </Field>
            {hasDataSource && (
              <TemplatePreview
                template={cmd.p}
                columns={columns}
                row={{ values: sample?.values ?? {}, row_no: sample?.row_no ?? 2, key: sample?.key ?? '' }}
                excelPath={excelPath}
              />
            )}
          </div>
        )}

        {cmd.type === 'text' && (
          <div className="space-y-3">
            <Field
              label="要输入的内容"
              hint={
                hasDataSource
                  ? '用 {列名} 取当前行的 Excel 数据；解析不到会让这一行失败，不会把占位符发出去'
                  : '按字面输入。宏没有数据源，写 {列名} 取不到值，会让这一步直接失败'
              }
            >
              <Textarea
                className="min-h-[90px]"
                value={cmd.p}
                placeholder="您好 {客户名称}，您的订单 {订单编号} 已处理"
                onChange={(e) => onChange({ p: e.target.value })}
              />
            </Field>
            {hasDataSource && !!variables.length && (
              <div className="flex flex-wrap gap-2">
                {variables.map((v) => (
                  <Button key={v} variant="outline" size="sm" onClick={() => onChange({ p: `${cmd.p}{${v}}` })}>
                    {`{${v}}`}
                  </Button>
                ))}
              </div>
            )}
            {hasDataSource && (
              <TemplatePreview
                template={cmd.p}
                columns={columns}
                row={{ values: sample?.values ?? {}, row_no: sample?.row_no ?? 2, key: sample?.key ?? '' }}
                excelPath={excelPath}
              />
            )}
          </div>
        )}

        {cmd.type === 'key' && (
          <div className="space-y-3">
            <Field
              label="组合键"
              hint="点「录制」按下想用的键，或直接手写。写错的键名会当场报出来 —— 否则跑起来只是「什么都没发生」"
            >
              {/* 换一条指令就重挂一次：手写草稿是组件内状态，不该跨指令串味 */}
              <KeyPicker key={cmdIndex} combo={key.combo} onChange={(combo) => setKey({ combo })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="重复次数">
                <Input
                  type="number"
                  min={1}
                  value={key.repeat}
                  onChange={(e) => setKey({ repeat: Math.max(1, Number(e.target.value) || 1) })}
                />
              </Field>
              <Field label="间隔（毫秒）">
                <Input
                  type="number"
                  min={0}
                  value={key.delayMs}
                  onChange={(e) => setKey({ delayMs: Math.max(0, Number(e.target.value) || 0) })}
                />
              </Field>
            </div>
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              组合键是「同时按下」：{comboLabel(key.combo)} 会一次按住这些键再一起松开，不是依次敲。
            </p>
          </div>
        )}

        {cmd.type === 'img' && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>图像素材</Label>
              <div className="flex items-center gap-3 rounded-lg border border-border p-2.5">
                <div className="flex size-[64px] flex-none items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40">
                  {asset ? (
                    <img src={api.imageRawUrl(asset.id)} alt={asset.name} className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className="text-[11px] text-muted-foreground">未选</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  {asset ? (
                    <>
                      <div className="truncate text-[13px]">{asset.name}</div>
                      <div className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {asset.width}×{asset.height} · {asset.id}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="secondary">{asset.tag}</Badge>
                        {asset.refCount > 1 && <Badge variant="default">另有 {asset.refCount - 1} 处引用</Badge>}
                      </div>
                    </>
                  ) : (
                    <div className={`text-[12.5px] ${assetMissing ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {assetMissing
                        ? `素材 ${image.assetId} 已不在库中，请重新选择`
                        : '还没选素材，执行前必须选一张'}
                    </div>
                  )}
                </div>
                <div className="flex flex-none flex-col gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
                    {image.assetId ? '更换' : '选择素材'}
                  </Button>
                  {!!image.assetId && (
                    <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setImage({ assetId: '' })}>
                      清除
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <Label>匹配阈值</Label>
                <span className="font-mono text-[12.5px] tabular-nums text-muted-foreground">{image.threshold.toFixed(2)}</span>
              </div>
              <Slider
                value={[image.threshold]}
                min={0.5}
                max={1}
                step={0.01}
                onValueChange={([v]) => setImage({ threshold: v })}
              />
              {/* 阈值是「这条指令」自己的参数，所以只给一个按钮，不偷偷改掉 */}
              {asset && Math.abs(asset.threshold - image.threshold) > 0.0001 && (
                <Button variant="ghost" size="sm" onClick={() => setImage({ threshold: asset.threshold })}>
                  用素材推荐值 {asset.threshold.toFixed(2)}
                </Button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="超时（秒）">
                <Input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={image.timeoutSec}
                  onChange={(e) => setImage({ timeoutSec: Number(e.target.value) || 0.5 })}
                />
              </Field>
              <Field label="找不到时">
                <Select value={image.onMiss} onValueChange={(v) => setImage({ onMiss: v as typeof image.onMiss })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fail">标记本行失败</SelectItem>
                    <SelectItem value="retry">再等一轮</SelectItem>
                    <SelectItem value="pause">暂停等人工</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="点击偏移 X">
                <Input type="number" value={image.offsetX} onChange={(e) => setImage({ offsetX: Number(e.target.value) || 0 })} />
              </Field>
              <Field label="点击偏移 Y">
                <Input type="number" value={image.offsetY} onChange={(e) => setImage({ offsetY: Number(e.target.value) || 0 })} />
              </Field>
            </div>
          </div>
        )}

        {cmd.type === 'flow' && (
          <div className="space-y-3">
            <Field label="等待秒数">
              <Input
                type="number"
                min={0}
                step={0.1}
                value={cmd.p}
                placeholder="1.5"
                onChange={(e) => onChange({ p: e.target.value })}
              />
            </Field>
            {hasDataSource && (
              <TemplatePreview
                template={cmd.p}
                columns={columns}
                row={{ values: sample?.values ?? {}, row_no: sample?.row_no ?? 2, key: sample?.key ?? '' }}
                excelPath={excelPath}
              />
            )}
          </div>
        )}

        {cmd.type === 'mouse' && (
          <Field label="点击偏移（x,y）" hint="相对于匹配到的图像中心">
            <Input value={cmd.p} placeholder="0, 0" onChange={(e) => onChange({ p: e.target.value })} />
          </Field>
        )}
      </CardContent>

      <ImagePicker
        open={picking}
        value={image.assetId}
        onPick={(asset) => setImage({ assetId: asset.id })}
        onClose={() => setPicking(false)}
      />
    </Card>
  )
}
