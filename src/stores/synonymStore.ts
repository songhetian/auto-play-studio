import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 意图定位用的「同义词表」——可自定义。
 *
 * 之前是硬编码在 intentLocate.ts 的 SYNONYM_GROUPS 常量，改词要动代码重打包。
 * 现在抽成持久化 store：用户在 UI 里增删组/词，跨会话记住，前端闭环、不动后端。
 * 引擎侧（Python）暂不分发这份表，纯前端定位够用（见 docs/intent-recognition-feasibility.md）。
 *
 * 同义词语义：同一组的词互为等价，匹配时任一命中都算该意图词命中；加一组只需 append 一行。
 */
const BUILTIN_GROUPS: string[][] = [['螺丝', '螺栓', '螺钉']]

interface SynonymState {
  /** 同义词组：每组内的词互为等价 */
  groups: string[][]
  setGroups: (groups: string[][]) => void
  addGroup: (group?: string[]) => void
  removeGroup: (index: number) => void
  addWord: (groupIndex: number, word: string) => void
  removeWord: (groupIndex: number, word: string) => void
  /** 回到内置默认（清掉用户自定义） */
  reset: () => void
}

export const useSynonymStore = create<SynonymState>()(
  persist(
    (set) => ({
      groups: BUILTIN_GROUPS.map((g) => [...g]),
      setGroups: (groups) => set({ groups: groups.map((g) => [...g]) }),
      addGroup: (group = []) =>
        set((s) => ({
          groups: [...s.groups, group.map((w) => w.trim()).filter(Boolean)],
        })),
      removeGroup: (index) =>
        set((s) => ({ groups: s.groups.filter((_, i) => i !== index) })),
      addWord: (groupIndex, word) =>
        set((s) => {
          const w = word.trim()
          if (!w || groupIndex < 0 || groupIndex >= s.groups.length) return s
          const groups = s.groups.map((g, i) =>
            i === groupIndex && !g.includes(w) ? [...g, w] : g,
          )
          return { groups }
        }),
      removeWord: (groupIndex, word) =>
        set((s) => {
          if (groupIndex < 0 || groupIndex >= s.groups.length) return s
          const groups = s.groups.map((g, i) =>
            i === groupIndex ? g.filter((x) => x !== word) : g,
          )
          return { groups }
        }),
      reset: () => set({ groups: BUILTIN_GROUPS.map((g) => [...g]) }),
    }),
    {
      name: 'autoplay.synonyms',
      version: 1,
    },
  ),
)
