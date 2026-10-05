import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useInstanceStore } from '@/stores/instanceStore'
import { toast } from '@/stores/toastStore'
import { controlToastText } from '@/lib/runToast'
import type { InstanceStatus } from '@/schemas/instance'

/**
 * 列表级运行控制：在「实例管理 / 总览 / 工具页」直接开始、暂停、继续、停止，
 * 不必点进实例窗口。
 *
 * 状态跃迁以后端回执为准（res.status），前端状态机只做守卫 —— 和实例窗口里的
 * 控制按钮同源，避免两套口径对不上。
 */
export function useInstanceControl() {
  const qc = useQueryClient()
  const transition = useInstanceStore((s) => s.transition)

  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'pause' | 'resume' | 'stop' }) =>
      api.control(id, action),
    onSuccess: (res, { id, action }) => {
      transition(id, res.status as InstanceStatus)
      qc.invalidateQueries({ queryKey: ['instances'] })
      toast.success(controlToastText(action))
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
