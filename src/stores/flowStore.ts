import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Flow, FlowStep } from '@/lib/flowSearch'

/**
 * 客服流程方案（多方案）的持久化状态。
 *
 * 顶层就是**方案数组**而不是"当前流程"——客服组里同时有退款、发货、投诉等
 * 一堆流程，20 个以后横向排列必然找不到人，所以查找交给 `flowSearch`。
 *
 * 每次改动的方案都会顺手盖上 `updatedAt`：列表默认按最近编辑排序，
 * 没有这个时间戳就没法把"刚弄过的那份"排在最前面。
 */
interface FlowState {
  flows: Flow[]
  /** 新增方案。空名字忽略。返回新 id */
  add: (f: { name: string; tags?: string[]; steps?: FlowStep[] }) => string
  /** 改方案字段（名字/标签/截图等）；自动盖 updatedAt */
  update: (id: string, patch: Partial<Omit<Flow, 'id' | 'steps'>>) => void
  remove: (id: string) => void
  /** 复制一份方案：步骤全部给新 id，名字加「副本」后缀 */
  duplicate: (id: string) => void

  /** 往指定方案加一步（只影响这一个方案） */
  addStep: (flowId: string, step: FlowStep) => void
  updateStep: (flowId: string, stepId: string, patch: Partial<FlowStep>) => void
  removeStep: (flowId: string, stepId: string) => void
  /** 步骤换位：delta = -1 上移 / +1 下移；越界不动 */
  moveStep: (flowId: string, stepId: string, delta: number) => void

  byId: (id: string) => Flow | undefined
}

const newId = (prefix: string) =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const nowIso = () => new Date().toISOString()

/** 只改某个方案，方案不存在时原样返回（安全空操作） */
const patchFlow = (flows: Flow[], id: string, fn: (f: Flow) => Flow): Flow[] =>
  flows.map((f) => (f.id === id ? fn(f) : f))

export const useFlowStore = create<FlowState>()(
  persist(
    (set, get) => ({
      flows: [],

      add: (f) => {
        const name = (f.name ?? '').trim()
        if (!name) return ''
        const id = newId('flow')
        set((s) => ({
          flows: [...s.flows, { id, name, tags: f.tags ?? [], steps: f.steps ?? [], updatedAt: nowIso() }],
        }))
        return id
      },

      update: (id, patch) =>
        set((s) => ({
          flows: patchFlow(s.flows, id, (f) => ({ ...f, ...patch, updatedAt: nowIso() })),
        })),

      remove: (id) => set((s) => ({ flows: s.flows.filter((f) => f.id !== id) })),

      duplicate: (id) => {
        const src = get().flows.find((f) => f.id === id)
        if (!src) return
        const copy: Flow = {
          ...src,
          id: newId('flow'),
          name: `${src.name} 副本`,
          // 步骤必须给新 id：共用 id 会让「跳到第 3 步」在两个方案之间串台
          steps: src.steps.map((s) => ({ ...s, id: newId('step') })),
          updatedAt: nowIso(),
        }
        set((s) => ({ flows: [...s.flows, copy] }))
      },

      addStep: (flowId, step) =>
        set((s) => ({
          flows: patchFlow(s.flows, flowId, (f) => ({
            ...f,
            steps: [...f.steps, step],
            updatedAt: nowIso(),
          })),
        })),

      updateStep: (flowId, stepId, patch) =>
        set((s) => ({
          flows: patchFlow(s.flows, flowId, (f) => ({
            ...f,
            steps: f.steps.map((x) => (x.id === stepId ? { ...x, ...patch } : x)),
            updatedAt: nowIso(),
          })),
        })),

      removeStep: (flowId, stepId) =>
        set((s) => ({
          flows: patchFlow(s.flows, flowId, (f) => ({
            ...f,
            steps: f.steps.filter((x) => x.id !== stepId),
            updatedAt: nowIso(),
          })),
        })),

      moveStep: (flowId, stepId, delta) =>
        set((s) => ({
          flows: patchFlow(s.flows, flowId, (f) => {
            const i = f.steps.findIndex((x) => x.id === stepId)
            const j = i + delta
            // 越界不动：把步骤甩出数组会静默丢内容
            if (i < 0 || j < 0 || j >= f.steps.length) return f
            const steps = [...f.steps]
            ;[steps[i], steps[j]] = [steps[j], steps[i]]
            return { ...f, steps, updatedAt: nowIso() }
          }),
        })),

      byId: (id) => get().flows.find((f) => f.id === id),
    }),
    { name: 'autoplay.flows', version: 1 },
  ),
)
