import { useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/blocks/empty-state'
import CmdInspector from '@/modules/instance/CmdInspector'
import { moveAt, remapIndex } from '@/modules/instance/cmdOrder'
import { comboLabel } from '@/lib/keys'
import { fadeUp } from '@/lib/motion'
import type { Cmd, RpaConfig } from '@/schemas/instance'

/**
 * 指令库：左边这一列可以往序列里加什么。
 *
 * 每一项都必须**真能执行** —— 预设名会直接变成指令名，和实际行为对不上就是骗人：
 * 例如「标记结果」其实只是 `flow`（延时），「窗口置顶」其实只是把窗口切到前台，
 * 用户照着填会得到完全不是他想要的效果。
 */
const CMD_LIB: Array<[string, Array<[string, Cmd['type']]>]> = [
  ['窗口与剪贴板', [
    ['激活窗口', 'win'],
    ['复制并粘贴话术', 'clip'],
    ['只复制内容', 'clip'],
    ['只粘贴', 'clip'],
  ]],
  ['键盘', [
    ['输入文本', 'text'],
    ['按键', 'key'],
  ]],
  ['鼠标', [
    ['点击图像', 'img'],
    ['在坐标点击', 'mouse'],
    ['双击图像', 'img'],
    ['移动鼠标', 'move'],
    ['滚轮翻页', 'scroll'],
    ['拖拽', 'drag'],
  ]],
  ['图像判定', [
    ['等待图片出现', 'waitimg'],
    ['点击图像', 'img'],
  ]],
  ['流程与排查', [
    ['延时等待', 'flow'],
    ['截图留证', 'shot'],
    ['读屏幕分辨率', 'screen'],
    ['读鼠标位置', 'screen'],
  ]],
]

/**
 * 指令类型的标识色。
 *
 * 原实现给每种类型写死了一个 hex，这里改用语义令牌 —— 令牌集里能拉开的色相有限，
 * 文本与图像两类会共用「成功绿」，但深色主题下不会再出现刺眼的自定义色。
 *
 * 新增指令类型时**必须在这里补一条**，否则 TS 会报缺键（这是故意的）——
 * 少一条的表现是序列里那条指令没有颜色，用户分不出它是什么。
 */
const TYPE_TONE: Record<Cmd['type'], string> = {
  win: 'bg-primary',
  text: 'bg-ok',
  key: 'bg-warn',
  mouse: 'bg-destructive',
  img: 'bg-ok',
  flow: 'bg-muted-foreground',
  move: 'bg-destructive/70',
  scroll: 'bg-destructive/70',
  drag: 'bg-destructive/70',
  clip: 'bg-ok/70',
  shot: 'bg-muted-foreground/70',
  waitimg: 'bg-warn/70',
  screen: 'bg-muted-foreground/70',
}

/** 序列条目上的一句话摘要：按键/图像指令也要能看出配了什么 */
function cmdSummary(c: Cmd, assetNameOf: (id: string) => string | undefined): string {
  // 剪贴板的摘要看「动作 + 内容」，它才是这条指令真正的内容
  if (c.type === 'clip') {
    const act = c.action || '待配置'
    const body = c.text ? (c.text.length > 20 ? `${c.text.slice(0, 20)}…` : c.text) : ''
    return body ? `${act}：${body}` : act
  }
  if (c.type === 'img' || c.type === 'waitimg') {
    const id = c.image?.assetId
    if (!id) return c.type === 'waitimg' ? '待选要等待的图片' : '待选图片'
    return (c.type === 'waitimg' ? '等待 ' : '') + (assetNameOf(id) ?? `素材 ${id}（已不在库中）`)
  }
  if (c.p) return c.p
  if (c.type === 'key') return c.key?.combo.length ? comboLabel(c.key.combo) : '待配置按键'
  return '待配置参数'
}

/**
 * 流程编排：指令库 + 可拖拽排序的序列 + 属性面板。
 *
 * `rpa`（跑 Excel）与 `macro`（按键精灵）**共用这一个组件** —— 两者的指令语汇
 * 完全一样，区别只在数据源，所以差异通过 `columns` / `sample` / `excelPath` 三个
 * 与数据源有关的入参表达，而不是各写一份编排界面。
 *
 * 选中项与拖拽状态都留在组件内：它们是纯 UI 状态，父页面没有理由知道。
 */
export default function CmdFlowEditor({
  cmds,
  variables,
  columns,
  sample,
  excelPath,
  hasDataSource,
  assetNameOf,
  onChange,
  onPatch,
}: {
  cmds: Cmd[]
  /** 可一键插入的列变量；宏没有数据源，传空数组 */
  variables: string[]
  columns: string[]
  /** 上传时抓下来的样例行，宏没有数据源，不传 */
  sample?: RpaConfig['sample']
  /** 上传的 Excel 路径，宏没有数据源，不传 */
  excelPath?: string
  /** 是否有数据源。为 false 时属性面板不显示模板预览与变量按钮 */
  hasDataSource: boolean
  assetNameOf: (id: string) => string | undefined
  onChange: (next: Cmd[]) => void
  onPatch: (index: number, patch: Partial<Cmd>) => void
}) {
  const [sel, setSel] = useState(-1)
  const dragFrom = useRef(-1)

  const addCmd = (name: string, type: Cmd['type']) => {
    // 新指令直接带上可用的默认参数，否则一保存就被校验拦下。
    // 每个分支都必须给出「能直接跑」的默认值：空的筛选项等于让用户先填一遍参数
    // 才知道对不对，而保存时会被 schema 先拦掉，体验很差。
    const seed: Partial<Cmd> =
      type === 'key'
        ? { key: { combo: ['Enter'], delayMs: 120, repeat: 1 } }
        : type === 'img'
          ? { image: { assetId: '', threshold: 0.85, timeoutSec: 5, offsetX: 0, offsetY: 0, onMiss: 'fail' } }
          : type === 'waitimg'
            ? { image: { assetId: '', threshold: 0.85, timeoutSec: 10, offsetX: 0, offsetY: 0, onMiss: 'fail' } }
            : type === 'clip'
              ? { action: name.includes('只复制') ? '复制' : name.includes('只粘贴') ? '粘贴' : '复制并粘贴', text: '' }
              : type === 'mouse'
                ? { button: 'left', clicks: name.includes('双击') ? 2 : 1 }
                : type === 'scroll'
                  ? { p: '-3' } // 滚轮最常见的是往下翻页
                  : type === 'screen'
                    ? { p: name.includes('鼠标') ? 'pos' : 'size' }
                    : type === 'shot'
                      ? { p: '' } // 路径必须用户自己填（没有合理的默认值）
                      : {}
    // flow 默认给 1 秒；其余类型 p 留空由用户填
    const defaultP = type === 'flow' ? '1' : seed.p ?? ''
    const next = [...cmds, { t: name, type, on: true, p: defaultP, ...seed } as Cmd]
    onChange(next)
    setSel(next.length - 1)
  }

  const moveCmd = (to: number) => {
    const from = dragFrom.current
    if (from < 0 || from === to) return
    onChange(moveAt(cmds, from, to))
    // 选中项跟着「它原来指的那条指令」走：只换数组、sel 还拿着旧下标的话，
    // 重排后右侧属性面板会指向另一条指令（以为在改 A，其实在改 B）
    setSel((s) => remapIndex(s, from, to))
    dragFrom.current = -1
  }

  return (
    <motion.div variants={fadeUp} className="grid grid-cols-12 gap-4">
      <div className="col-span-12 lg:col-span-3">
        <Card>
          <CardHeader>
            <CardTitle>指令库</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {CMD_LIB.map(([group, items]) => (
              <div key={group} className="space-y-1">
                <div className="px-1 text-xs text-muted-foreground">{group}</div>
                {items.map(([name, type]) => (
                  <Button
                    key={name}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => addCmd(name, type)}
                    className="h-8 w-full justify-start gap-2 font-normal"
                  >
                    <span className={`size-[7px] flex-none rounded-full ${TYPE_TONE[type]}`} />
                    {name}
                    <span className="ml-auto text-xs text-muted-foreground">添加</span>
                  </Button>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="col-span-12 lg:col-span-5">
        <Card>
          <CardHeader>
            <CardTitle>指令序列</CardTitle>
            <Badge variant="secondary">{cmds.length} 条</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {cmds.map((c, i) => (
              <div
                key={i}
                draggable
                onDragStart={() => (dragFrom.current = i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => moveCmd(i)}
                onClick={() => setSel(i)}
                className={`flex cursor-pointer items-center gap-2.5 rounded-md border p-2.5 transition-colors ${
                  sel === i ? 'border-primary ring-2 ring-primary/15' : 'border-border hover:bg-accent/40'
                }`}
              >
                <span className="flex size-5 flex-none items-center justify-center rounded-full bg-muted font-mono text-xs tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <span
                  className={`flex size-7 flex-none items-center justify-center rounded-md text-xs text-primary-foreground ${TYPE_TONE[c.type]}`}
                >
                  {c.t.slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-base font-medium">{c.t}</div>
                  <div className="truncate text-sm text-muted-foreground">{cmdSummary(c, assetNameOf)}</div>
                </div>
              </div>
            ))}
            {!cmds.length && <EmptyState icon="boxes" title="还没有指令" desc="从左侧指令库点击添加" />}
          </CardContent>
        </Card>
      </div>

      <div className="col-span-12 lg:col-span-4">
        <CmdInspector
          cmd={sel >= 0 ? (cmds[sel] ?? null) : null}
          cmdIndex={sel}
          variables={variables}
          columns={columns}
          sample={sample}
          excelPath={excelPath}
          hasDataSource={hasDataSource}
          onChange={(patch) => onPatch(sel, patch)}
          onRemove={() => {
            onChange(cmds.filter((_, i) => i !== sel))
            setSel(-1)
          }}
        />
      </div>
    </motion.div>
  )
}
