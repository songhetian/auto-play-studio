import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReminderWatcher } from './ReminderWatcher'
import { isoLocal, useReminderStore } from '@/stores/reminderStore'

/**
 * 到期弹窗在**开着的时候**必须自己把「已逾期 N 分钟」往前走。
 *
 * 之前 30s 轮询在「仍在到期」时 `setActive` 返回同一个引用，React 据此跳过重渲染，
 * 弹窗里的时间就冻住了 —— 而这条提醒恰恰是唯一不能自动关掉、必须当场处理的那类。
 * 光看"弹窗能弹出"发现不了这个问题，所以这里断言的是**时间在走**。
 */
describe('ReminderWatcher 开着时的倒计时', () => {
  let container: HTMLDivElement
  let root: Root

  /** 弹窗里那段「已逾期 N 分钟」 */
  const overdueLabel = () => (document.body.textContent ?? '').match(/已逾期 \d+ 分钟/)?.[0]

  beforeEach(() => {
    vi.useFakeTimers()
    // React 18 的 act 需要显式声明自己在测试环境里
    ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    useReminderStore.setState({ reminders: [] })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('弹窗不关掉的时候，已逾期时长会自己往上走', () => {
    const now = new Date('2026-10-05T10:00:00')
    vi.setSystemTime(now)
    useReminderStore.setState({
      reminders: [
        {
          id: 'r1',
          content: '给张三回电',
          // 5 分钟前就该处理了 → 属于"已到期"，弹窗会拦下来
          at: isoLocal(new Date(now.getTime() - 5 * 60_000)),
          category: 'work',
          done: false,
          createdAt: isoLocal(new Date(now.getTime() - 65 * 60_000)),
        },
      ],
    })

    act(() => root.render(<ReminderWatcher />))

    expect(overdueLabel()).toBe('已逾期 5 分钟')

    // 弹窗还开着，时间过去 2 分钟 —— 文案必须跟着变
    act(() => {
      vi.advanceTimersByTime(2 * 60_000)
    })

    expect(overdueLabel()).toBe('已逾期 7 分钟')
  })

  it('完成的提醒不再弹', () => {
    const now = new Date('2026-10-05T10:00:00')
    vi.setSystemTime(now)
    useReminderStore.setState({
      reminders: [
        {
          id: 'r2',
          content: '已完成的事',
          at: isoLocal(new Date(now.getTime() - 10 * 60_000)),
          category: 'work',
          done: true,
        },
      ],
    })

    act(() => root.render(<ReminderWatcher />))

    expect(overdueLabel()).toBeUndefined()
  })
})
