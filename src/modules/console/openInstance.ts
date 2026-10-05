import { ipc } from '@/lib/ipc'
import type { Instance } from '@/schemas/instance'

/**
 * 「打开实例窗口」的解析结果。
 *
 * - `opened`   真的开出了独立窗口（Electron 环境）
 * - `fallback` 当前环境开不了独立窗口（纯浏览器预览），给出同页路由让调用方导航过去
 */
export type OpenInstanceResult =
  | { kind: 'opened'; supported: true }
  | { kind: 'fallback'; supported: false; route: string }

/** 实例配置/运行页的路由：与 `App.tsx` 里的 `<Route path="/instance/:id/:view">` 保持一致 */
export const instanceRoute = (inst: Pick<Instance, 'id'>, view: 'config' | 'run') =>
  `/instance/${inst.id}/${view}`

/**
 * 打开实例的配置或运行页。
 *
 * 为什么不直接 `ipc.openInstance(...)` 就完事：它在没有 Electron 桥时降级返回 `false`，
 * 而调用方都没看返回值 —— 于是浏览器预览里点「配置」毫无反应，又没有任何提示，
 * 看起来就像按钮坏了。这里把「开不了」也变成一种**明确的、可被 UI 消费的结果**。
 */
export async function resolveOpenInstance(
  inst: Pick<Instance, 'id' | 'tool' | 'name'>,
  view: 'config' | 'run',
): Promise<OpenInstanceResult> {
  const route = instanceRoute(inst, view)
  const ok = await ipc.openInstance({ id: inst.id, tool: inst.tool, name: inst.name, route })
  return ok ? { kind: 'opened', supported: true } : { kind: 'fallback', supported: false, route }
}
