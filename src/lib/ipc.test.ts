import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipc } from './ipc'

/**
 * 绝对路径只能从 preload 拿：浏览器出于安全不把磁盘位置暴露给 JS。
 * 所以「没有桥时必须返回空串」这条契约要钉住 ——
 * 返回一句编造的路径比返回空更糟（界面会拿它去登记，然后永远扫不出文件）。
 */
afterEach(() => vi.unstubAllGlobals())

describe('ipc.getPathForFile', () => {
  it('有桥时用桥给的绝对路径', () => {
    const file = new File([new Uint8Array([1])], 'a.txt')
    vi.stubGlobal('api', { getPathForFile: (f: File) => (f === file ? 'D:\\资料\\售后\\a.txt' : '') })

    expect(ipc.getPathForFile(file)).toBe('D:\\资料\\售后\\a.txt')
  })

  it('没有桥（浏览器预览）时返回空串_绝不编造路径', () => {
    const file = new File([new Uint8Array([1])], 'a.txt')
    expect(ipc.getPathForFile(file)).toBe('')
  })
})

describe('ipc.enginePort', () => {
  it('有桥时用主进程注入的端口', () => {
    vi.stubGlobal('api', { enginePort: 9001 })

    expect(ipc.enginePort()).toBe(9001)
  })

  it('没有桥时返回 null，交给调用方兜底', () => {
    expect(ipc.enginePort()).toBeNull()
  })
})

describe('ipc.kbPanelHotkey', () => {
  it('有桥时用主进程给的键名', async () => {
    vi.stubGlobal('api', { kbPanelHotkey: async () => 'Ctrl + Alt + K' })

    expect(await ipc.kbPanelHotkey()).toBe('Ctrl + Alt + K')
  })

  it('没有桥时为空串 —— 键名只有主进程知道，渲染层不编一个出来', async () => {
    expect(await ipc.kbPanelHotkey()).toBe('')
  })
})

describe('ipc.appHotkeys', () => {
  it('有桥时一次取全四个键名', async () => {
    const labels = {
      phrase: 'Ctrl + Alt + P',
      kb: 'Ctrl + Alt + K',
      firstReply: 'Ctrl + Alt + R',
      suggest: 'Ctrl + Alt + S',
    }
    vi.stubGlobal('api', { appHotkeys: async () => labels })

    expect(await ipc.appHotkeys()).toEqual(labels)
  })

  it('没有桥时回一组空键名：这些键本来就不存在，调用方该整块不显示而不是报错', async () => {
    expect(await ipc.appHotkeys()).toEqual({ phrase: '', kb: '', firstReply: '', suggest: '' })
  })
})
