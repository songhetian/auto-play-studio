import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Kbd } from '@/components/ui/kbd'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Icon } from '@/components/icon'
import {
  DEFAULT_HOTKEY_MAP,
  HOTKEY_ACTIONS,
  HOTKEY_ACTION_LABEL,
  HOTKEY_SCOPES,
  HOTKEY_SCOPE_LABEL,
  accelFromEvent,
  formatAccel,
  validateGlobalAccel,
} from '@/lib/hotkey'
import type { HotkeyAction, HotkeyMap, HotkeyScope } from '@/lib/hotkey'

/**
 * 全局快捷键编辑器。
 *
 * 交互就一件事：点一下 → 按下想用的键 → 完成。不需要用户知道「F9」该怎么拼写，
 * 也不需要他们在输入框里手打。录键期间明确提示在录制，按 Esc 取消。
 *
 * 动作清单来自 `HOTKEY_ACTIONS`，**不在这里硬编码** —— 多加一个动作
 * （比如给按键精灵加的 `run`）只要改那一处，这个组件自动跟上。
 */
export function HotkeyEditor({
  value,
  onChange,
  /** 已被其它实例占用的键 → 占用者名字，用于就地提示冲突 */
  conflicts,
  disabled,
}: {
  value: HotkeyMap
  onChange: (patch: Partial<HotkeyMap>) => void
  conflicts?: (action: HotkeyAction, accel: string) => string[]
  disabled?: boolean
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {HOTKEY_ACTIONS.map((action) => (
          <HotkeyRecorder
            key={action}
            action={action}
            accel={value[action]}
            onChange={(accel) => onChange({ [action]: accel })}
            others={conflicts?.(action, value[action]) ?? []}
            disabled={disabled}
          />
        ))}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="hotkey-scope">按下之后作用于</Label>
        <Select
          value={value.scope}
          onValueChange={(v) => onChange({ scope: v as HotkeyScope })}
          disabled={disabled}
        >
          <SelectTrigger id="hotkey-scope" className="w-full sm:w-[240px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HOTKEY_SCOPES.map((s) => (
              <SelectItem key={s} value={s}>
                {HOTKEY_SCOPE_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          {value.scope === 'window'
            ? '默认只作用于这个实例，别的实例不会被牵连。'
            : '会作用于同工具的全部实例 —— 比如一次把一批监控任务都停掉。'}
        </p>
      </div>
    </div>
  )
}

const DEFAULTS: Record<HotkeyAction, string> = {
  run: DEFAULT_HOTKEY_MAP.run,
  toggle: DEFAULT_HOTKEY_MAP.toggle,
  stop: DEFAULT_HOTKEY_MAP.stop,
}

/** 每个动作一句话说清按下去会发生什么 */
const ACTION_DESC: Record<HotkeyAction, string> = {
  run: '空闲时按下即开始；窗口没开会自动拉起来。',
  toggle: '按下即暂停；再按一下继续。',
  stop: '按下即停止当前这一轮。',
}

function HotkeyRecorder({
  action,
  accel,
  onChange,
  others,
  disabled,
}: {
  action: HotkeyAction
  accel: string
  onChange: (accel: string) => void
  others: string[]
  disabled?: boolean
}) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState('')
  const btnRef = useRef<HTMLButtonElement>(null)
  const validCheck = validateGlobalAccel(accel)
  const invalid = !validCheck.ok

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        setError('')
        return
      }
      const next = accelFromEvent(e)
      if (!next) return // 还在按修饰键，继续等主键
      const check = validateGlobalAccel(next)
      if (!check.ok) {
        setError(check.reason)
        return
      }
      setError('')
      setRecording(false)
      onChange(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, onChange])

  const reason = error || (validCheck.ok ? '' : validCheck.reason)

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5">
        {HOTKEY_ACTION_LABEL[action]}
        {others.length > 0 && !recording && (
          <Badge variant="warning" className="gap-1">
            <Icon name="warning" size={11} />
            与 {others.length} 个实例重复
          </Badge>
        )}
      </Label>

      <div className="flex items-center gap-2">
        <Button
          ref={btnRef}
          type="button"
          variant={recording ? 'default' : 'outline'}
          onClick={() => {
            setError('')
            setRecording((v) => !v)
          }}
          disabled={disabled}
          className={cn('h-9 min-w-[150px] justify-between font-mono', invalid && !recording && 'border-destructive text-destructive')}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={recording ? 'rec' : accel}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.12 }}
              className="flex items-center gap-1.5"
            >
              {recording ? (
                <>
                  <span className="size-1.5 animate-pulse rounded-full bg-current" />
                  请按下要用的键…
                </>
              ) : (
                <Kbd className="border-0 bg-transparent px-0 text-[12.5px] text-current">{formatAccel(accel)}</Kbd>
              )}
            </motion.span>
          </AnimatePresence>
          <Icon name={recording ? 'close' : 'pencil'} size={13} className="opacity-60" />
        </Button>

        {accel !== DEFAULTS[action] && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(DEFAULTS[action])} disabled={disabled}>
            恢复默认
          </Button>
        )}
      </div>

      {reason ? (
        <p className="text-[11.5px] leading-relaxed text-destructive">{reason}</p>
      ) : others.length ? (
        <p className="text-[11.5px] leading-relaxed text-[hsl(var(--warn))]">
          {others.join('、')} 也绑了这个键。按下时只会作用于其中一个（优先当前焦点窗口），不会一起生效 —— 想各自独立就换个键。
        </p>
      ) : (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          {recording ? '按下想用的键即可录制。' : ACTION_DESC[action]}
        </p>
      )}
    </div>
  )
}
