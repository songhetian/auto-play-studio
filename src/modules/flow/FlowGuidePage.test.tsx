import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import FlowGuidePage from './FlowGuidePage'
import { useFlowStore } from '@/stores/flowStore'
import type { Flow } from '@/lib/flowSearch'

/**
 * 切换方案时，`FlowDetail` 必须**重挂**。
 *
 * 它内部持有「当前第几步」和「标签输入框（默认值）」，不加 `key` 就会被复用：
 * 从甲的第 3 步切到乙，预览直接落在乙的第 3 步、标签框还显示甲的标签。
 * 这类"状态跟着上一屏走"的 bug 靠看代码最容易漏，所以用渲染锁住。
 */
const flow = (id: string, name: string, tags: string[], steps: number): Flow => ({
  id,
  name,
  tags,
  steps: Array.from({ length: steps }, (_, i) => ({ id: `${id}-s${i}`, title: `步骤${i + 1}`, desc: '' })),
})

describe('方案浏览器的分步预览', () => {
  let container: HTMLDivElement
  let root: Root

  /** 点文本匹配的按钮（方案卡片 / 上一步 / 下一步） */
  const clickByText = (text: string) => {
    const el = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes(text),
    )
    if (!el) throw new Error(`界面上找不到按钮：${text}`)
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  /** 「分步预览」右侧那段：第 2 / 3 步 */
  const stepLabel = () => (document.body.textContent ?? '').match(/第 \d+ \/ \d+ 步/)?.[0]

  beforeEach(() => {
    ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    useFlowStore.setState({
      flows: [flow('f1', '退款处理方案', ['售后'], 3), flow('f2', '发货跟进方案', ['物流'], 2)],
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('换方案时分步预览回到第 1 步', () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <FlowGuidePage />
        </MemoryRouter>,
      ),
    )

    clickByText('退款处理方案')
    expect(stepLabel()).toBe('第 1 / 3 步')

    clickByText('下一步')
    expect(stepLabel()).toBe('第 2 / 3 步')

    // 换方案：必须回到第 1 步，而不是停在上一个方案的第 2 步
    clickByText('发货跟进方案')
    expect(stepLabel()).toBe('第 1 / 2 步')
  })

  it('换方案时分类标签输入框跟着换', () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <FlowGuidePage />
        </MemoryRouter>,
      ),
    )

    clickByText('退款处理方案')
    expect((document.querySelector('#tags-f1') as HTMLInputElement).value).toBe('售后')

    clickByText('发货跟进方案')
    expect((document.querySelector('#tags-f2') as HTMLInputElement).value).toBe('物流')
  })
})
