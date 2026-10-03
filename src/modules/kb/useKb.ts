import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { KbStatus } from '@/lib/api'

/** 知识库的查询与变更都收在这里，页面只管画 */

const STATUS = ['kb', 'status'] as const
const HISTORY = ['kb', 'history'] as const
const searchKey = (q: string) => ['kb', 'search', q] as const

/** 索引在跑的时候轮询快一点；停下来就慢下来，别让一个空闲页面每秒打一次接口 */
const IDLE_POLL_MS = 5000
const BUSY_POLL_MS = 400

export function useKbStatus(enabled = true) {
  return useQuery({
    queryKey: STATUS,
    queryFn: api.kbStatus,
    enabled,
    refetchInterval: (query) => {
      const data = query.state.data as KbStatus | undefined
      return data?.indexing.running ? BUSY_POLL_MS : IDLE_POLL_MS
    },
  })
}

/**
 * 搜索。命中结果按查询串缓存 —— 来回改字时不会每次都打接口。
 *
 * `enabled` 由页面按「查询非空」控制：空查询不是搜索，不该记进历史
 * （后端也会挡，但没必要发这一趟）。
 */
export function useKbSearch(query: string, enabled = true) {
  const q = query.trim()
  return useQuery({
    queryKey: searchKey(q),
    queryFn: () => api.kbSearch(q),
    enabled: enabled && !!q,
    staleTime: 30_000,
  })
}

export function useKbHistory(enabled = true) {
  return useQuery({ queryKey: HISTORY, queryFn: () => api.kbHistory(), enabled, staleTime: 30_000 })
}

/**
 * 索引跑完后要刷新的东西：
 *  - 状态（进度 / 文档数）
 *  - 历史（这一轮可能没有新搜索，但搜索计数变了）
 * 不变的是搜索结果本身：索引变了结果就可能变，所以整族前缀失效。
 */
function useKbRefresh() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['kb'] })
  }
}

export function useKbAddFolder() {
  const refresh = useKbRefresh()
  return useMutation({ mutationFn: api.kbAddFolder, onSuccess: refresh })
}

export function useKbRemoveFolder() {
  const refresh = useKbRefresh()
  return useMutation({ mutationFn: api.kbRemoveFolder, onSuccess: refresh })
}

export function useKbReindex() {
  const refresh = useKbRefresh()
  return useMutation({ mutationFn: api.kbReindex, onSuccess: refresh })
}

export function useKbClearHistory() {
  const refresh = useKbRefresh()
  return useMutation({ mutationFn: api.kbClearHistory, onSuccess: refresh })
}

/** 打开原文件 —— 引擎会用系统默认程序打开，这里只负责把失败原因带回来 */
export function useKbOpenFile() {
  return useMutation({ mutationFn: api.kbOpen })
}

export type { KbStatus }
