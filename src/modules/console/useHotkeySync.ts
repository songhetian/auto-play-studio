import { useEffect, useMemo, useState } from 'react'
import { hasGlobalHotkeys, ipc } from '@/lib/ipc'
import { expandHotkeyBindings, findHotkeyConflicts, hotkeyMapOf } from '@/lib/hotkey'
import type { HotkeyConflict, HotkeyOwner } from '@/lib/hotkey'
import { useInstanceStore } from '@/stores/instanceStore'
import { isLive } from '@/modules/console/instanceStatus'

export interface HotkeySyncState {
  /** 冲突：同一个键被多个实例占用同一动作 */
  conflicts: HotkeyConflict[]
  /** 注册失败（被别的程序占了）的按键 */
  failed: string[]
}

/**
 * 把「全部实例的热键」同步给主进程。
 *
 * 放在控制台做，而不是放在各个实例窗口做，理由是：
 *  - 控制台是唯一知道全部实例的地方，冲突检测只有在全量视角下才有意义；
 *  - 实例窗口关掉之后热键仍然有效（主进程按注册表路由，必要时把窗口拉起来）。
 */
export function useHotkeySync(): HotkeySyncState {
  const instances = useInstanceStore((s) => s.instances)
  const [failed, setFailed] = useState<string[]>([])

  const owners = useMemo<HotkeyOwner[]>(
    () =>
      Object.values(instances).map((i) => ({
        id: i.id,
        name: i.name,
        tool: i.tool,
        hotkeys: hotkeyMapOf(i.config),
      })),
    [instances],
  )

  const conflicts = useMemo(() => findHotkeyConflicts(owners), [owners])

  useEffect(() => {
    if (!hasGlobalHotkeys) return
    const bindings = expandHotkeyBindings(
      Object.values(instances).map((i) => ({
        id: i.id,
        name: i.name,
        tool: i.tool,
        live: isLive(i.status),
        hotkeys: hotkeyMapOf(i.config),
      })),
    )
    let alive = true
    void ipc.syncHotkeys(bindings).then((r) => {
      if (alive) setFailed(r.failed)
    })
    return () => {
      alive = false
    }
  }, [instances])

  return { conflicts, failed }
}
