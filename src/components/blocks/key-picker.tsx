import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Icon } from '@/components/icon'
import { comboFromEvent, comboTokens, comboToText, normalizeCombo } from '@/lib/keys'

/**
 * 指令级键位拾取器。
 *
 * 交互和老老实实敲一个组合键是一回事：点「录制」→ 按下 `Ctrl+Shift+C` → 完成。
 * 手写也留着（`Ctrl+C` / `Enter`），但**写错当场报错**，不给你保存一个
 * pyautogui 认不出来的键 —— 那种错的表现是「跑起来什么都没发生」，
 * 是最难查的一类故障。
 *
 * 与 `HotkeyEditor` 的区别：那个配的是**主进程全局键**（Electron accelerator 语汇），
 * 这个配的是**让目标程序替你按一下**（pyautogui 语汇）。两套词表不一样，别互相参考。
 */

/** 常用组合键：点一下就能用，省得每次录制 */
const PRESETS: string[][] = [
  ['ctrl', 'c'],
  ['ctrl', 'v'],
  ['ctrl', 'a'],
  ['ctrl', 'x'],
  ['ctrl', 'z'],
  ['ctrl', 'enter'],
  ['enter'],
  ['tab'],
  ['escape'],
]

export function KeyPicker({
  combo,
  onChange,
  disabled,
}: {
  /** 当前生效的按键（配置里存的那一份） */
  combo: string[]
  /** 只在按键合法时被调用 —— 非法写法永远不会进配置 */
  onChange: (combo: string[]) => void
  disabled?: boolean
}) {
  const [recording, setRecording] = useState(false)
  /** 手写时的草稿。合法就提交并丢弃草稿，非法就留着让用户看见自己写了什么 */
  const [draft, setDraft] = useState<string | null>(null)
  const [hint, setHint] = useState('')

  // 录制期间监听器挂在 window 上；用 ref 拿最新的回调，免得每次渲染都重挂一遍
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const text = draft ?? comboToText(combo)
  const reason = recording ? '' : draft === null ? '' : normalizeCombo(draft).reason

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      // 捕获阶段拦下：录制期间不让任何按键漏给页面（否则会触发导航、快捷键等）
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        setHint('')
        return
      }
      const next = comboFromEvent(e)
      if (!next) {
        setHint('修饰键已经按住了，再按一个主键')
        return
      }
      setRecording(false)
      setHint('')
      setDraft(null)
      onChangeRef.current(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])

  const commit = (next: string[]) => {
    setDraft(null)
    onChangeRef.current(next)
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={recording ? '' : text}
          readOnly={recording}
          disabled={disabled}
          spellCheck={false}
          placeholder={recording ? '请按下要用的组合键…' : 'Ctrl+C / Enter'}
          aria-invalid={!!reason}
          className={cn(
            'font-mono',
            recording && 'border-primary ring-2 ring-primary/25',
            reason && 'border-destructive text-destructive focus-visible:ring-destructive',
          )}
          onChange={(e) => {
            const v = e.target.value
            const r = normalizeCombo(v)
            if (r.reason) setDraft(v)
            else commit(r.combo)
          }}
          onBlur={() => {
            // 离开时把合法写法回填成规范形式（`ctrl+c` → `Ctrl+C`）
            if (draft !== null && !normalizeCombo(draft).reason) setDraft(null)
          }}
        />
        <Button
          type="button"
          variant={recording ? 'default' : 'outline'}
          disabled={disabled}
          className="h-9 flex-none"
          onClick={() => {
            setHint('')
            setRecording((v) => !v)
          }}
        >
          <Icon name={recording ? 'close' : 'keyboard'} size={13} />
          {recording ? '取消' : '录制'}
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {recording && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-2 text-[12px] text-primary"
          >
            <span className="size-1.5 flex-none animate-pulse rounded-full bg-primary" />
            {hint || '按下要用的组合键…（Esc 取消）'}
          </motion.div>
        )}
      </AnimatePresence>

      {/*
        这一行是**真相**：配置里实际存着什么，跑起来就会按什么。
        手写写错时输入框里是错的那串，但这里仍然显示会执行的那个键 ——
        否则「输入框空着、配置里却还有旧键」就自相矛盾了。
      */}
      <div className="flex min-h-5 flex-wrap items-center gap-1.5">
        <span className="text-[11.5px] text-muted-foreground">{reason ? '实际生效：' : ''}</span>
        {combo.length ? (
          comboTokens(combo).map((tk, i) => <Kbd key={`${tk}-${i}`}>{tk}</Kbd>)
        ) : (
          <span className="text-[11.5px] text-muted-foreground">还没设置按键</span>
        )}
        {reason && <span className="text-[11.5px] leading-relaxed text-destructive">{reason}</span>}
      </div>

      <div className="space-y-1.5">
        <div className="text-[11.5px] text-muted-foreground">常用</div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((c) => (
            <Button
              key={c.join('+')}
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              // 用无空格的写法：与输入框里的格式一致，窄列下一行也能多放一个
              className="h-6 px-2 font-mono text-[11.5px]"
              onClick={() => commit(c)}
            >
              {comboToText(c)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
