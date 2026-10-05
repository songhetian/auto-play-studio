import { describe, expect, it } from 'vitest'
import {
  BLUR_SETTLE_MS,
  REFOCUS_SETTLE_MS,
  captureForeground,
  escapeSendKeys,
  insertText,
  restoreForeground,
  restoreScript,
  sendEnter,
  sendPaste,
  sendTyped,
  typeScript,
  type FocusDeps,
  type InsertDeps,
} from './phraseFocus'

/**
 * 「话术送进目标窗口」的编排规格。
 *
 * 设备调用（PowerShell / 剪贴板）本身只在员工机人工验收，这里测的是**编排**：
 * 顺序对不对、句柄传没传对、失败会不会把整条链路带崩。
 */
function fakeDeps(scripts: string[], outputs: string[] = []): FocusDeps {
  return {
    run: async (s) => {
      scripts.push(s)
      return outputs.shift() ?? ''
    },
    delay: async () => {},
  }
}

describe('captureForeground', () => {
  it('解析出前台窗口句柄', async () => {
    const scripts: string[] = []
    const hwnd = await captureForeground(fakeDeps(scripts, ['  123456  ']))
    expect(hwnd).toBe(123456)
    expect(scripts[0]).toContain('GetForegroundWindow')
  })

  it('输出不是数字时返回 null（不让整条链路崩）', async () => {
    expect(await captureForeground(fakeDeps([], ['']))).toBeNull()
    expect(await captureForeground(fakeDeps([], ['oops']))).toBeNull()
    expect(await captureForeground(fakeDeps([], ['0']))).toBeNull()
  })

  it('执行失败时返回 null', async () => {
    const deps: FocusDeps = {
      run: async () => {
        throw new Error('powershell 不在')
      },
      delay: async () => {},
    }
    expect(await captureForeground(deps)).toBeNull()
  })
})

describe('restoreForeground', () => {
  it('脚本里带上目标句柄与 SetForegroundWindow', async () => {
    const scripts: string[] = []
    await restoreForeground(9988, fakeDeps(scripts))
    expect(scripts[0]).toContain('SetForegroundWindow')
    expect(scripts[0]).toContain('[IntPtr]9988')
    // 先 SW_RESTORE 再设前台：最小化窗口也能拉回来
    expect(scripts[0]).toContain('ShowWindow')
  })

  it('执行失败时不抛（尽力而为）', async () => {
    const deps: FocusDeps = {
      run: async () => {
        throw new Error('x')
      },
      delay: async () => {},
    }
    await expect(restoreForeground(1, deps)).resolves.toBeUndefined()
  })

  it('restoreScript 生成可执行的单行命令', () => {
    expect(restoreScript(42)).toContain('[IntPtr]42')
  })
})

describe('sendPaste', () => {
  it('发的是 Ctrl+V', async () => {
    const scripts: string[] = []
    await sendPaste(fakeDeps(scripts))
    expect(scripts[0]).toContain("SendKeys('^v')")
  })

  it('执行失败时不抛', async () => {
    const deps: FocusDeps = {
      run: async () => {
        throw new Error('x')
      },
      delay: async () => {},
    }
    await expect(sendPaste(deps)).resolves.toBeUndefined()
  })
})

describe('insertText', () => {
  function recorder() {
    const calls: string[] = []
    const scripts: string[] = []
    const deps: InsertDeps = {
      run: async (s) => {
        scripts.push(s)
        return 'ok'
      },
      delay: async () => {
        calls.push('delay')
      },
      writeClipboard: (t) => calls.push(`clip:${t}`),
      hidePanel: () => calls.push('hide'),
    }
    return { calls, scripts, deps }
  }

  it('有目标句柄：写剪贴板 → 藏面板 → 还焦点 → 粘贴，顺序固定', async () => {
    const { calls, scripts, deps } = recorder()
    await insertText('您好', 777, deps)

    expect(calls).toEqual(['clip:您好', 'hide', 'delay', 'delay'])
    // 第一段跑的是还焦点，第二段跑的是粘贴
    expect(scripts[0]).toContain('[IntPtr]777')
    expect(scripts[1]).toContain("SendKeys('^v')")
  })

  it('没有目标句柄：跳过还焦点，仍然粘贴给当前焦点窗口', async () => {
    const { calls, scripts, deps } = recorder()
    await insertText('您好', null, deps)

    expect(calls).toEqual(['clip:您好', 'hide'])
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain("SendKeys('^v')")
  })

  it('等待时长在两个阶段各留一段，保证焦点切换生效', () => {
    expect(BLUR_SETTLE_MS).toBeGreaterThan(0)
    expect(REFOCUS_SETTLE_MS).toBeGreaterThan(0)
  })
})

/**
 * 第二条注入通道：模拟输入（SendKeys 逐字打）。
 *
 * 有些聊天窗口禁用了粘贴（或粘贴会丢格式），剪贴板那一路就废了。
 * 此时改走"照着敲"—— 代价是文字里若混进 SendKeys 的元字符，会被当成快捷键
 * （`+` 是 Shift、`^` 是 Ctrl），所以**转义是这条通道的命门**，必须钉死。
 */
describe('模拟输入通道', () => {
  it('转义 SendKeys 元字符：不转义就会被当成快捷键', () => {
    expect(escapeSendKeys('感谢+已处理')).toBe('感谢{+}已处理')
    expect(escapeSendKeys('(备注)')).toBe('{(}备注{)}')
    expect(escapeSendKeys('50%')).toBe('50{%}')
    expect(escapeSendKeys('a~b^c')).toBe('a{~}b{^}c')
  })

  it('大括号自身也要转义，否则会和外层语法打架', () => {
    expect(escapeSendKeys('{变量}')).toBe('{{}变量{}}')
  })

  it('换行统一成一次回车（含 CRLF）', () => {
    expect(escapeSendKeys('a\nb')).toBe('a{ENTER}b')
    expect(escapeSendKeys('a\r\nb')).toBe('a{ENTER}b')
  })

  it('方括号不是 SendKeys 元字符，保持原样（多转义反而会被当按键码）', () => {
    expect(escapeSendKeys('[ok]')).toBe('[ok]')
  })

  it('typeScript 生成的脚本里带上转义后的文本', () => {
    expect(typeScript('谢+')).toContain("SendKeys('谢{+}')")
  })

  it('typeScript 把单引号拆成两个，避免 PowerShell 字符串提前闭合', () => {
    expect(typeScript("it's")).toContain("it''s")
  })

  it('sendTyped 跑的是模拟输入脚本', async () => {
    const scripts: string[] = []
    await sendTyped('hi', fakeDeps(scripts))
    expect(scripts[0]).toContain('SendKeys')
  })

  it('sendTyped 执行失败时不抛（尽力而为）', async () => {
    const deps: FocusDeps = {
      run: async () => {
        throw new Error('x')
      },
      delay: async () => {},
    }
    await expect(sendTyped('hi', deps)).resolves.toBeUndefined()
  })

  it('sendEnter 发的是回车（自动发送才用，默认不发送）', async () => {
    const scripts: string[] = []
    await sendEnter(fakeDeps(scripts))
    expect(scripts[0]).toContain("SendKeys('{ENTER}')")
  })
})