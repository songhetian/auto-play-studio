import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AssistTarget } from '@/lib/api'

/**
 * 速查填入的查询与变更：目标配置（填到哪个窗口的哪块输入框）+ 填入动作。
 *
 * 和 `useKb`（索引、检索、历史）分开：那边关心「库里有什么」，这边关心
 * 「怎么把找到的东西送进客服客户端」，两件事的失效时机也不同。
 */

const TARGET = ['assist', 'target'] as const
const WINDOWS = ['assist', 'windows'] as const

/** 框定的输入框；没配过是 `null`（不是错误） */
export function useAssistTarget() {
  return useQuery({
    queryKey: TARGET,
    queryFn: () => api.assistTarget().then((r) => r.target),
    staleTime: 60_000,
  })
}

export function useSaveAssistTarget() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.saveAssistTarget,
    // 服务端回的就是权威值：直接写进缓存，省掉一次往返
    onSuccess: (r) => qc.setQueryData(TARGET, r.target),
  })
}

/** 当前打开的窗口标题，给关键字输入框做候选 */
export function useAssistWindows(enabled = true) {
  return useQuery({
    queryKey: WINDOWS,
    queryFn: async () => (await api.assistWindows()).windows,
    enabled,
    // 窗口开关得很频繁，但没必要为此长轮询；打开下拉时刷新一次就够
    staleTime: 15_000,
  })
}

/** 把一段话术填进输入框（不发送）。错误由调用方提示 —— 它才知道是哪一条。 */
export function useAssistFill() {
  return useMutation({ mutationFn: api.assistFill })
}

export type { AssistTarget }
