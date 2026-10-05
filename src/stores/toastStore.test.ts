import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TOASTS, TOAST_DURATION, toast, useToastStore } from '@/stores/toastStore'

const state = () => useToastStore.getState()

beforeEach(() => state().clear())
afterEach(() => vi.useRealTimers())

describe('toast 队列', () => {
  it('toast.success 进队列，带上人话与色调', () => {
    toast.success('已复制全部 3 条')

    expect(state().items.map((t) => [t.tone, t.message])).toEqual([['success', '已复制全部 3 条']])
  })

  it('最新的排在最前，右上角一眼看到的就是刚发生的事', () => {
    toast.info('第一条')
    toast.info('第二条')

    expect(state().items.map((t) => t.message)).toEqual(['第二条', '第一条'])
  })

  it('dismiss 按 id 摘掉那一条，别的留着', () => {
    const id = toast.info('这条要被关掉')
    toast.info('这条留着')

    state().dismiss(id)

    expect(state().items.map((t) => t.message)).toEqual(['这条留着'])
  })

  it('超过上限只留最新的几条，不刷屏盖住页面', () => {
    for (let i = 1; i <= MAX_TOASTS + 2; i++) toast.info(`第 ${i} 条`)

    expect(state().items).toHaveLength(MAX_TOASTS)
    expect(state().items[0].message).toBe(`第 ${MAX_TOASTS + 2} 条`)
  })
})

describe('toast 自动消失', () => {
  it('到点自己消失，不用手动关', () => {
    vi.useFakeTimers()
    toast.success('一闪而过')

    vi.advanceTimersByTime(TOAST_DURATION + 10)

    expect(state().items).toHaveLength(0)
  })

  it('duration 传 0 表示常驻，得手动关', () => {
    vi.useFakeTimers()
    toast.error('必须看到', 0)

    vi.advanceTimersByTime(TOAST_DURATION * 10)

    expect(state().items).toHaveLength(1)
  })
})
