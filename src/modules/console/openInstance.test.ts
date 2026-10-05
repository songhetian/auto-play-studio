import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { resolveOpenInstance } from './openInstance'

/**
 * 打开实例窗口的行为规格。
 *
 * 背景：这个项目平时跑在 Electron 里，实例配置/运行都在独立窗口。但同一份渲染层
 * 也会在纯浏览器里跑（开发预览、纯 Web 降级），此时没有 `window.api.openInstance`。
 * 原来 `ipc.openInstance` 直接降级返回 `false`，调用方直接忽略返回值 ——
 * 用户点了「配置」什么都没发生，也没有任何提示，看起来像按钮坏了。
 *
 * 规格：
 *  - 有 Electron 桥 → 调它开窗口，返回 opened
 *  - 无桥（浏览器）→ 不能静默失败，要返回 fallback 路由让调用方在当前窗口导航，
 *    并标记 supported=false 让 UI 能说明原因
 */
describe('resolveOpenInstance', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { ...window, api: undefined })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const inst = { id: 'R1', tool: 'rpa', name: '千牛-自动回复' } as never

  it('有 Electron 桥时开独立窗口，并返回 opened', async () => {
    const openInstance = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('window', { ...window, api: { openInstance } })

    const res = await resolveOpenInstance(inst, 'config')

    expect(res.kind).toBe('opened')
    expect(openInstance).toHaveBeenCalledTimes(1)
    // 路由必须是 config，且带上实例 id —— 开错视图等于白开
    expect(openInstance.mock.calls[0][0]).toMatchObject({
      id: 'R1',
      route: '/instance/R1/config',
    })
  })

  it('无 Electron 桥时返回同页路由作为降级，而不是静默失败', async () => {
    const res = await resolveOpenInstance(inst, 'config')

    expect(res.kind).toBe('fallback')
    expect(res).toMatchObject({ supported: false, route: '/instance/R1/config' })
  })

  it('run 视图的降级路由与 config 区分开', async () => {
    const res = await resolveOpenInstance(inst, 'run')

    expect(res).toMatchObject({ kind: 'fallback', route: '/instance/R1/run' })
  })

  it('实例 id 里若含斜杠也能拼出正确路由（不做多余转义，交给 HashRouter 解析）', async () => {
    const weird = { id: 'a/b', tool: 'rpa', name: 'x' } as never
    const res = await resolveOpenInstance(weird, 'config')

    expect(res).toMatchObject({ kind: 'fallback', route: '/instance/a/b/config' })
  })
})
