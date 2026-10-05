import { api } from '@/lib/api'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/** 一条话术。字段名与引擎返回的 camelCase 一一对应（`engine/phrases/service.py`） */
export interface Phrase {
  id: number
  title: string
  body: string
  category: string
  usedCount: number
  createdAt: string
  updatedAt: string
}

export const phraseKeys = {
  all: ['phrases'] as const,
  list: (q: string, category: string) => ['phrases', 'list', q, category] as const,
  categories: ['phrases', 'categories'] as const,
}

/** 话术列表：常用在前（引擎侧已排序），支持关键词与分类筛选 */
export function usePhrases(q = '', category = '') {
  return useQuery({
    queryKey: phraseKeys.list(q, category),
    queryFn: () => api.listPhrases({ q, category }),
  })
}

export function usePhraseCategories() {
  return useQuery({ queryKey: phraseKeys.categories, queryFn: api.phraseCategories })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: phraseKeys.all })
  }
}

/**
 * 保存话术。**标题相同即覆盖**（引擎侧行为）：
 * 用户改一句说辞是"覆盖原来那条"，不是"越积越多"——列表里两条同名会让人不知该用哪条。
 */
export function useSavePhrase() {
  return useMutation({
    mutationFn: (p: { id?: number; title: string; body: string; category: string }) =>
      p.id ? api.patchPhrase(p.id, p) : api.createPhrase(p),
    onSuccess: useInvalidate(),
  })
}

export function useDeletePhrase() {
  return useMutation({
    mutationFn: (id: number) => api.removePhrase(id),
    onSuccess: useInvalidate(),
  })
}

/**
 * 记一次使用。
 *
 * 发出去的动作本身就是最好的"常用度"信号，比让用户手动点收藏靠谱 ——
 * 客服不会为了维护列表去点"常用"按钮，但会自然地重复用同一句。
 */
export function useMarkPhraseUsed() {
  return useMutation({
    mutationFn: (id: number) => api.markPhraseUsed(id),
    onSuccess: useInvalidate(),
  })
}
