import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { toolById } from '@/app/moduleRegistry'
import { resolveOpenInstance } from '@/modules/console/openInstance'
import { toast } from '@/stores/toastStore'
import type { Instance, ToolType } from '@/schemas/instance'

/**
 * 实例窗口的打开方式集中在这里：多开架构下每个实例都是独立窗口。
 *
 * 独立窗口开不出来时（纯浏览器预览，没有 Electron 桥）会退化成「在当前窗口打开同一页」，
 * 至少让按钮是有用的，而不是点了没反应。
 */
export function useOpenInstanceWindow() {
  const navigate = useNavigate()
  return async (inst: Instance, view: 'config' | 'run') => {
    const res = await resolveOpenInstance(inst, view)
    if (res.kind === 'fallback') navigate(res.route)
    return res
  }
}

/**
 * 非 React 环境（模块顶层、回调里）用的便捷版本：能开独立窗口就开，
 * 开不了就让调用方自己处理。**不要**在组件外拿它做导航。
 */
export const openInstanceWindow = async (inst: Instance, view: 'config' | 'run') => {
  const res = await resolveOpenInstance(inst, view)
  return res.kind === 'opened'
}

/**
 * 实例的增删复制：总览 / 实例管理 / 工具页三处共用，
 * 免得每个页面各写一遍 mutation 与缓存失效。
 */
export function useInstanceActions() {
  const qc = useQueryClient()
  const openWindow = useOpenInstanceWindow()
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
      toast.success(`已新建实例「${inst.name}」`)
      // 新建后直接进配置页：空实例没有可运行的东西，先去配
      void openWindow(inst, 'config')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const clone = useMutation({
    mutationFn: (id: string) => api.clone(id),
    onSuccess: (inst) => {
      invalidate()
      toast.success(`已复制为「${inst.name}」`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.remove(id),
    onSuccess: () => {
      invalidate()
      toast.success('已删除实例')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return { create, clone, remove }
}
