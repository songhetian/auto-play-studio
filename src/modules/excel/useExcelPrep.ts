import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/** 表格体检与整理的查询/变更都收在这里，页面只管画 */

/**
 * 体检报告按「文件 + 主键列」缓存：改主键列要重判重复主键，换文件当然更要。
 *
 * `retry: false` 是刻意的 —— 文件不存在（404）、后缀不对、主键列写错（400）
 * 都是**用户当下要看的那句话**，重试三次只会让这句话晚两秒出现。
 */
export function useExcelReport(path: string, keyCol: string) {
  return useQuery({
    queryKey: ['excel', 'report', path, keyCol],
    queryFn: () => api.excelInspect(path, keyCol),
    enabled: !!path,
    staleTime: 60_000,
    retry: false,
  })
}

export function useExcelClean() {
  return useMutation({
    mutationFn: (p: { path: string; keyCol: string; acceptRisk: boolean }) =>
      api.excelClean(p.path, p.keyCol, p.acceptRisk),
  })
}

/** 打开整理后的文件：走引擎的白名单，只有它自己产出过的路径能过 */
export function useExcelOpen() {
  return useMutation({ mutationFn: api.excelOpen })
}
