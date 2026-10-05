import { useEffect, useState } from 'react'
import { hasRegionPicker, ipc } from '@/lib/ipc'
import { toast } from '@/stores/toastStore'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Icon } from '@/components/icon'
import { targetFromRegion, targetLabel } from '@/modules/kb/fillTarget'
import { useAssistTarget, useAssistWindows, useSaveAssistTarget } from '@/modules/kb/useAssist'

/**
 * 「填入目标」配置条：告诉系统「话术要打进哪个窗口的哪块输入框」。
 *
 * 为什么必须框一次而不是让它自己找：客服客户端的输入框在不同平台、不同分辨率、
 * 不同布局下位置都不一样，而且这些客户端不暴露可读的控件树（京麦 / 飞鸽 / 千牛
 * 都是 Chromium 自绘）。位置只能由人指一次。
 *
 * 为什么窗口填的是**关键字**不是完整标题：引擎是按「标题包含」激活窗口的，
 * 而千牛的标题会随登录账号、会话数变化 —— 写死完整标题过两天就匹不上了。
 */
export function AssistTargetBar() {
  const saved = useAssistTarget()
  const windows = useAssistWindows()
  const save = useSaveAssistTarget()
  const [keyword, setKeyword] = useState('')
  const [picking, setPicking] = useState(false)

  const target = saved.data ?? null

  // 配过就把关键字回填：重新框选不用再打一遍
  useEffect(() => {
    if (target?.window) setKeyword((cur) => cur || target.window)
  }, [target?.window])

  const pick = async () => {
    setPicking(true)
    try {
      const region = await ipc.selectRegion()
      const next = targetFromRegion(keyword, region)
      if (!next) {
        // 用户取消框选是正常操作，但不能不吭声 —— 他会以为已经框上了
        toast.info(region ? '这块区域没有面积，请重新框一下' : '已取消，填入目标没有改动')
        return
      }
      save.mutate(next, {
        onSuccess: (r) => toast.success(`填入目标已设为「${r.target.window}」`),
        onError: (e: Error) => toast.error(e.message),
      })
    } finally {
      setPicking(false)
    }
  }

  const ready = hasRegionPicker

  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon name="target" size={13} />
        </span>
        <span className="font-medium">填入目标</span>
        <span className={target ? 'text-muted-foreground' : 'text-warning'}>{targetLabel(target)}</span>

        <div className="flex-1" />

        {/* 候选来自真实打开的窗口 —— 让人从存在的标题里挑，比让他猜一个可靠 */}
        <Input
          list="assist-target-windows"
          className="h-8 w-[190px]"
          placeholder="窗口关键字，如 千牛"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <datalist id="assist-target-windows">
          {(windows.data ?? []).map((w) => (
            <option key={w} value={w} />
          ))}
        </datalist>

        <Button
          variant="outline"
          size="sm"
          disabled={!ready || !keyword.trim() || picking}
          onClick={() => void pick()}
          title={ready ? '把客服客户端的输入框框出来' : '只有桌面端能框选'}
        >
          <Icon name="crop" size={13} />
          {target ? '重新框选' : '框选输入框'}
        </Button>
      </div>

      <p className="mt-1.5 text-xs text-muted-foreground">
        {ready
          ? '框选后话术会填进这个位置，但不会替你按发送 —— 发出去之前你自己看一眼。'
          : '浏览器预览里没有框选能力，请在桌面端使用。'}
      </p>
    </Card>
  )
}
