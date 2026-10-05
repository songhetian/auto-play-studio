import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import PhraseQuickPanel from './PhraseQuickPanel'
import { api } from '@/lib/api'
import { ipc } from '@/lib/ipc'

/**
 * 速查面板有两条出口，接错线是静默的 —— 面板照常关闭、界面毫无异样，
 * 只有客服发现"我按了 Enter，内容却跑到别处去了"。所以这里钉住的是**接线**：
 *
 *  - `Ctrl+Alt+K`（kb 模式）→ 内容进引擎的 assist 链路，填进框定的输入框；
 *  - `Ctrl+Alt+P`（phrase 模式）→ 知识库命中只复制到剪贴板，一个字都不许往聊天框塞。
 *
 * 列表排序、文本拼装、Enter 动作决策这些纯逻辑在 quickSearch.test.ts 里单独钉，
 * 这里不重复，只验证"面板有没有照那张表分发"。
 */

vi.mock('@/lib/api', () => {
  const kb = [
    {
      path: 'doc/a.md',
      fileName: '退费政策.md',
      fileType: 'md',
      size: 0,
      mtime: 0,
      truncated: false,
      score: 1,
      matchMode: 'and',
      matchCount: 1,
      matchedBy: 'keyword',
      snippets: [{ line: 1, text: '超过 7 天可退' }],
    },
  ]
  return {
    api: {
      kbSearch: vi.fn(async () => ({ results: kb })),
      listInstances: vi.fn(async () => []),
      markPhraseUsed: vi.fn(async () => {}),
      assistFill: vi.fn(async () => ({ filled: true, window: '千牛' })),
    },
  }
})

vi.mock('@/lib/ipc', () => ({
  ipc: {
    onPhrasePanelOpen: vi.fn(() => () => {}),
    phraseHotkey: vi.fn(async () => 'Ctrl + Alt + P'),
    kbPanelHotkey: vi.fn(async () => 'Ctrl + Alt + K'),
    insertPhrase: vi.fn(async () => true),
    closePhrasePanel: vi.fn(async () => true),
    copyText: vi.fn(() => true),
  },
}))

vi.mock('@/modules/phrases/usePhrases', () => ({
  usePhrases: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
}))

vi.mock('@/stores/attendantStore', () => ({
  useAttendantStore: (sel: (s: { autoFillVars: boolean }) => unknown) => sel({ autoFillVars: false }),
}))

/** 知识库检索有 200ms 防抖，等过它再断言列表 */
const KB_DEBOUNCE_MS = 200

type OpenPayload = { seed?: string; mode?: 'phrase' | 'kb' }

describe('PhraseQuickPanel 的两条出口', () => {
  let container: HTMLDivElement
  let root: Root

  /** 主进程送来的「面板打开了」回调（渲染层靠它重置并知道这次是哪个键唤起的） */
  const openPanel = async (payload: OpenPayload) => {
    const cb = vi.mocked(ipc.onPhrasePanelOpen).mock.calls[0]?.[0] as ((p: OpenPayload) => void) | undefined
    if (!cb) throw new Error('面板没有订阅 onPhrasePanelOpen')
    await act(async () => {
      cb(payload)
    })
    // 让 kbSearch 的防抖跑完
    await act(async () => {
      await new Promise((r) => setTimeout(r, KB_DEBOUNCE_MS + 60))
    })
  }

  const clickItem = async (idx: number) => {
    const el = container.querySelector<HTMLElement>(`[data-idx="${idx}"]`)
    if (!el) throw new Error(`列表里没有第 ${idx} 项，当前渲染：${container.textContent}`)
    await act(async () => {
      el.click()
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('Ctrl+Alt+K：选中的知识库内容填进框定的输入框，而不是插回原窗口', async () => {
    await act(async () => {
      root.render(<PhraseQuickPanel />)
    })
    await openPanel({ mode: 'kb', seed: '退款' })

    expect(container.textContent).toContain('退费政策.md')
    await clickItem(0)

    expect(vi.mocked(api.assistFill)).toHaveBeenCalledWith('超过 7 天可退')
    // 走的是 assist 链路，就不该再动"唤起前那个窗口"
    expect(vi.mocked(ipc.insertPhrase)).not.toHaveBeenCalled()
    // 填完收面板，回到聊天窗口
    expect(vi.mocked(ipc.closePhrasePanel)).toHaveBeenCalled()
  })

  it('Ctrl+Alt+P：知识库命中只复制到剪贴板，一个字都不往聊天框塞', async () => {
    await act(async () => {
      root.render(<PhraseQuickPanel />)
    })
    await openPanel({ mode: 'phrase', seed: '退款' })

    await clickItem(0)

    expect(vi.mocked(ipc.copyText)).toHaveBeenCalledWith('超过 7 天可退')
    expect(vi.mocked(api.assistFill)).not.toHaveBeenCalled()
    expect(vi.mocked(ipc.insertPhrase)).not.toHaveBeenCalled()
  })

  it('没框过输入框时把原因留在面板上，不关面板（关了就看不到线索了）', async () => {
    vi.mocked(api.assistFill).mockRejectedValueOnce(
      new Error('还没框定客服输入框，先点「框选输入框」把它框出来'),
    )
    await act(async () => {
      root.render(<PhraseQuickPanel />)
    })
    await openPanel({ mode: 'kb', seed: '退款' })

    await clickItem(0)

    expect(container.textContent).toContain('没填进去')
    expect(container.textContent).toContain('框选输入框')
    expect(vi.mocked(ipc.closePhrasePanel)).not.toHaveBeenCalled()
  })

  it('页脚显示的唤起键跟着入口走，按 K 唤起来就不该显示 P', async () => {
    await act(async () => {
      root.render(<PhraseQuickPanel />)
    })
    await openPanel({ mode: 'kb' })

    expect(container.textContent).toContain('Ctrl + Alt + K')
  })
})
