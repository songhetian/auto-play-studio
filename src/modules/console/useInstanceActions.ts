import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { ipc } from '@/lib/ipc'
import { toolById } from '@/app/moduleRegistry'
import type { Instance, ToolType } from '@/schemas/instance'

/** 实例窗口的打开方式集中在这里：多开架构下每个实例都是独立窗口 */
export const openInstanceWindow = (inst: Instance, view: 'config' | 'run') =>
  ipc.openInstance({ id: inst.id, tool: inst.tool, name: inst.name, route: `/instance/${inst.id}/${view}` })

/**
 * 实例的增删复制：总览 / 实例管理 / 工具页三处共用，
 * 免得每个页面各写一遍 mutation 与缓存失效。
 */
export function useInstanceActions() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['instances'] })

  const create = useMutation({
    /**
     * 带 planId 时从方案起手：把方案里的配置拷一份给新实例。
     * 之后两者互不影响 —— 改实例不改方案，改方案不改已有实例。
     */
    mutationFn: ({ tool, planId, name }: { tool: ToolType; planId?: string; name?: string }) =>
      api.createInstance({ name: name || toolById(tool).name, tool, planId }),
    onSuccess: (inst) => {
      invalidate()
      // 新建后直接进配置页：空实例没有可运行的东西，先去配
      openInstanceWindow(inst, 'config')
    },
  })

  const clone = useMutation({ mutationFn: (id: string) => api.clone(id), onSuccess: invalidate })
  const remove = useMutation({ mutationFn: (id: string) => api.remove(id), onSuccess: invalidate })

  return { create, clone, remove }
}
