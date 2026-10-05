import { useEffect, useMemo, useState } from 'react'
import { ipc, hasElectron, type WindowInfo } from '@/lib/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Icon } from '@/components/icon'
import { Field } from '@/components/blocks/field'
import { cn } from '@/lib/utils'

const NONE = '__none__'

/**
 * 目标窗口选择。
 *
 * 为什么要有降级路径：窗口列表由 Electron 主进程枚举，纯浏览器环境（开发预览、
 * 页面版）拿不到，`listWindows()` 会返回空数组。原来的做法是直接渲染一个
 * 空下拉框 —— 用户点开发现什么都没有，既不知道是环境问题也不知道该怎么办，
 * 看起来就像"功能坏了"。
 *
 * 现在：
 *  - 有 Electron 桥 → 下拉选，标注所属进程；窗口关掉了也留在列表里并标灰说明
 *  - 没有桥 → **改成手填窗口标题关键字**（引擎本来就支持按关键字匹配），
 *    并明确说明「当前环境无法自动枚举，桌面端会自动列出窗口」
 */
export function WindowPicker({
  label = '目标窗口',
  value,
  onChange,
  error,
  hint,
  className,
}: {
  label?: string
  value: string
  onChange: (next: string) => void
  error?: string
  hint?: string
  className?: string
}) {
  const [windows, setWindows] = useState<WindowInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  // 没有桥时用户走手填；一旦选了窗口就回到下拉，避免两处状态打架
  const [manual, setManual] = useState(!hasElectron)

  useEffect(() => {
    if (!hasElectron) {
      setLoaded(true)
      return
    }
    let alive = true
    void ipc.listWindows().then((list) => {
      if (alive) {
        setWindows(list)
        setLoaded(true)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  // 打开时刷新一次：用户是切到别的程序才想起回来选窗口的，列表太旧等于没枚举
  useEffect(() => {
    if (!hasElectron || manual) return
    void ipc.listWindows().then(setWindows)
  }, [manual])

  const titles = useMemo(() => windows.map((w) => w.title), [windows])

  if (!loaded) {
    return (
      <Field label={label} className={className}>
        <div className="flex h-8 items-center gap-2 rounded-md border border-input px-3 text-sm text-muted-foreground">
          <Icon name="refresh" size={13} className="animate-spin" />
          正在读取窗口列表…
        </div>
      </Field>
    )
  }

  // 无桥：手填。引擎按标题关键字匹配，前提是填得够准，所以要说明这一点。
  if (manual) {
    return (
      <Field
        label={label}
        error={error}
        className={className}
        hint={hint ?? '填目标窗口标题里的关键字即可，例如「企业微信」'}
      >
        <div className="space-y-2">
          <Input
            value={value}
            placeholder="例如 企业微信 / 千牛 / Chrome"
            onChange={(e) => onChange(e.target.value)}
            aria-label={label}
          />
          <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <Icon name="info" size={12} className="mt-0.5 flex-none" />
            <span>
              当前环境无法自动枚举窗口，已切换为手填标题。
              <b className="font-medium">在桌面版里这里会自动列出所有窗口</b>，直接选即可、不用手敲。
            </span>
          </p>
        </div>
      </Field>
    )
  }

  // 有桥但一个窗口都没枚举到（刚开机、或全最小化）：也别只给空下拉
  const empty = titles.length === 0

  return (
    <Field
      label={label}
      error={error}
      className={className}
      hint={hint ?? (empty ? '没有读到窗口：请确认目标程序已打开（最小化的也行）' : '列表由主进程枚举，仅影响当前实例')}
    >
      <div className="space-y-1.5">
        <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
          <SelectTrigger className={cn(empty && 'text-muted-foreground')}>
            <SelectValue placeholder={empty ? '暂时没有可绑定的窗口' : '请选择要绑定的窗口'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>（不绑定）</SelectItem>
            {titles.map((t) => {
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
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setManual(true)}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            列表里没有？改为手填标题
          </button>
          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => void ipc.listWindows().then(setWindows)}>
            <Icon name="refresh" size={12} />
            刷新
          </Button>
        </div>
      </div>
    </Field>
  )
}

export { NONE as WINDOW_NONE }
