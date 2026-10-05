import { useState } from 'react'
import { ipc, hasElectron } from '@/lib/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Icon } from '@/components/icon'
import { cn } from '@/lib/utils'

/**
 * 路径输入 + 「选择…」按钮。
 *
 * 为什么要它：路径手打既慢又容易错（反斜杠、中文、多余空格）。
 * Electron 里能直接弹系统对话框；**没有桥时（浏览器预览）自动降级为纯手填**，
 * 不做静默失败 —— 否则点按钮一点反应都没有，看着像坏了。
 *
 * 两种选择：
 * - `mode="file"`：选文件（Excel 等），受 `accept` 过滤
 * - `mode="dir"`：选输出目录
 */
export function PathPicker({
  value,
  onChange,
  mode = 'file',
  accept,
  placeholder,
  disabled,
  error,
  readOnly,
  hint,
}: {
  value: string
  onChange: (v: string) => void
  mode?: 'file' | 'dir'
  /** mode=file 时的扩展名过滤，如 'xlsx;xls;csv' */
  accept?: string
  placeholder?: string
  disabled?: boolean
  error?: boolean
  readOnly?: boolean
  hint?: string
}) {
  const [picking, setPicking] = useState(false)

  const pick = async () => {
    setPicking(true)
    try {
      // 传了 accept 就用通用文件选择（selectWorkbook 写死只认 xlsx/xlsm，
      // 会让「xlsx;csv」这类面板点开却选不到 csv）；没传则维持原来的表格选择。
      const got =
        mode === 'dir'
          ? await ipc.selectFolder()
          : accept
            ? await ipc.selectFile({ accept })
            : await ipc.selectWorkbook()
      // null = 没有 Electron 桥（或用户取消）。取消不该改值，手填继续可用。
      if (got) onChange(got)
    } finally {
      setPicking(false)
    }
  }

  // 只有真机能弹系统对话框；浏览器预览里不显示那个按钮（点了也是空的）
  const canPick = hasElectron

  return (
    <div className={cn('space-y-1.5')}>
      <div className="flex items-center gap-1.5">
        <Input
          value={value}
          readOnly={readOnly}
          disabled={disabled}
          error={error}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={cn(!readOnly && canPick && 'font-mono text-sm')}
          aria-label="路径"
        />
        {canPick && !readOnly && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || picking}
            onClick={() => void pick()}
            title={mode === 'dir' ? '选择输出文件夹' : '选择文件'}
          >
            <Icon name="folder" size={13} />
            {mode === 'dir' ? '选文件夹' : '选文件'}
          </Button>
        )}
      </div>
      {!canPick && !readOnly && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          浏览器预览里不能弹系统对话框，请直接粘贴完整路径；桌面版这里有「选择」按钮。
        </p>
      )}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}