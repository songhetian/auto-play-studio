import { useMutation, useQuery } from '@tanstack/react-query'
import { api, type ToolboxMergeIn } from '@/lib/api'

/** Excel 工具箱的查询/变更都收在这里，页面只管画 */

/**
 * 读列名。`retry: false` 是刻意的 —— 文件不存在（404）、后缀不对（400）
 * 都是用户当下要看的那句话，重试只会让这句话晚两秒出现。
 */
export function useToolboxColumns(path: string, enabled = true) {
  return useQuery({
    queryKey: ['excel-toolbox', 'columns', path],
    queryFn: () => api.toolboxColumns(path),
    enabled: enabled && !!path,
    staleTime: 60_000,
    retry: false,
  })
}

export function useToolboxMerge() {
  return useMutation({ mutationFn: (p: ToolboxMergeIn) => api.toolboxMerge(p) })
}

export function useToolboxGenerate() {
  return useMutation({ mutationFn: (p: { path: string; columns: string[] }) => api.toolboxGenerate(p.path, p.columns) })
}

export function useToolboxDedupe() {
  return useMutation({ mutationFn: (p: { path: string; keys: string[] }) => api.toolboxDedupe(p.path, p.keys) })
}

export function useToolboxConvert() {
  return useMutation({ mutationFn: (p: { path: string; target: 'xlsx' | 'csv' }) => api.toolboxConvert(p.path, p.target) })
}

export function useToolboxSplit() {
  return useMutation({ mutationFn: (p: { path: string; column: string }) => api.toolboxSplit(p.path, p.column) })
}

export function useToolboxFilter() {
  return useMutation({
    mutationFn: (p: { path: string; column: string; value: string }) => api.toolboxFilter(p.path, p.column, p.value),
  })
}

export function useToolboxProblemRows() {
  return useMutation({ mutationFn: (p: { path: string; keyColumn: string }) => api.toolboxProblemRows(p.path, p.keyColumn) })
}
