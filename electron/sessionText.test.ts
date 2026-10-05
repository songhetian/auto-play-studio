import { describe, expect, it } from 'vitest'
import {
  COPY_SETTLE_MS,
  SELECTION_QUERY_MAX,
  captureSelection,
  readSelection,
  selectionToQuery,
  type ClipDeps,
} from './sessionText'
import type { FocusDeps } from './phraseFocus'

/**
 * 选区取文本（坐席辅助的第④步：选区为主、剪贴板兜底）。
 *
 * 为什么要"选区为主"：客服要建议的那句话，往往就是他在聊天窗口里刚框住的那句。
 * 直接问系统"当前选了什么"最准、也最不动用户的剪贴板。
 * 但 UIA 拿不到选取框（很多自绘客户端就不支持）时，只能退到"模拟 Ctrl+C"——
 * 那条路会污染剪贴板，所以必须**先存后还**。
 */

function focusDeps(scripts: string[], outputs: string[] = []): FocusDeps {
  return {
    run: async (s) => {
      scripts.push(s)
      return outputs.shift() ?? ''
    },
    delay: async () => {},
  }
}

/** 一个可读写的假剪贴板：copy 后 read 返回新值 */
function fakeClip(initial = '') {
  const writes: string[] = []
  let value = initial
  const deps: ClipDeps = {
    read: () => value,
    write: (t) => {
      value = t
      writes.push(t)
    },
  }
  return {
    deps,
    writes,
    set: (v: string) => {
      value = v
    },
  }
}

describe('readSelection（UIA 直接读选区）', () => {
  it('返回去掉首尾空白的选区文本', async () => {
    expect(await readSelection(focusDeps([], ['  我的订单  \n']))).toBe('我的订单')
  })

  it('脚本执行失败时返回空串（好让它退到剪贴板兜底）', async () => {
    const deps: FocusDeps = {
      run: async () => {
        throw new Error('no uia')
      },
      delay: async () => {},
    }
    expect(await readSelection(deps)).toBe('')
  })
})

describe('captureSelection（选区为主、剪贴板兜底）', () => {
  it('UIA 拿到选区时直接用，不碰剪贴板', async () => {
    const scripts: string[] = []
    const clip = fakeClip('旧内容')
    expect(await captureSelection(focusDeps(scripts, ['选中的话']), clip.deps)).toBe('选中的话')
    expect(clip.writes).toEqual([])
    expect(scripts).toHaveLength(1)
  })

  it('UIA 拿不到时模拟 Ctrl+C，读到新内容就返回，并还原原剪贴板', async () => {
    const scripts: string[] = []
    const clip = fakeClip('旧内容')
    // UIA 输出空 → 走兜底；Ctrl+C 之后剪贴板变成选中的话
    const deps: FocusDeps = {
      run: async (s) => {
        scripts.push(s)
        if (s.includes('^c')) {
          clip.set('选中的话')
          return 'ok'
        }
        return '' // UIA 什么也没读到
      },
      delay: async () => {},
    }
    expect(await captureSelection(deps, clip.deps)).toBe('选中的话')
    expect(scripts.some((s) => s.includes('^c'))).toBe(true)
    // 必须把用户原来的剪贴板还回去，不能因为辅助功能把人家的内容冲掉
    expect(clip.writes).toEqual(['旧内容'])
  })

  it('没有选中内容（Ctrl+C 后剪贴板没变）返回空串，不把旧剪贴板当选区', async () => {
    const clip = fakeClip('旧内容')
    const deps: FocusDeps = {
      run: async () => '',
      delay: async () => {},
    }
    expect(await captureSelection(deps, clip.deps)).toBe('')
  })

  it('两边都空时返回空串', async () => {
    const clip = fakeClip('')
    expect(await captureSelection(focusDeps([], ['']), clip.deps)).toBe('')
  })

  it('兜底读取留了一段等待时间，不然剪贴板还没写进去', () => {
    expect(COPY_SETTLE_MS).toBeGreaterThan(0)
  })
})

describe('selectionToQuery（把选区变成可检索的一句话）', () => {
  it('取最后一行 —— 客户最新那条消息才是要回的那句', () => {
    expect(selectionToQuery('客户：你好\n客户：我的订单什么时候发货')).toBe('客户：我的订单什么时候发货')
  })

  it('CRLF 与空行都当换行处理', () => {
    expect(selectionToQuery('a\r\n\r\n  b  ')).toBe('b')
  })

  it('行内多余空白折叠成一个空格', () => {
    expect(selectionToQuery('我   要   退款')).toBe('我 要 退款')
  })

  it('整段都是空白时返回空串（调用方据此提示用户先划一句）', () => {
    expect(selectionToQuery('')).toBe('')
    expect(selectionToQuery('  \n \t ')).toBe('')
  })

  it('超长的一行截断到上限，避免整个段落当查询词', () => {
    const got = selectionToQuery('x'.repeat(SELECTION_QUERY_MAX + 50))
    expect(got).toHaveLength(SELECTION_QUERY_MAX)
  })
})