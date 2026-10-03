import type { ElectronApi, HotkeyAction, HotkeyBinding, HotkeyRouted } from '../../electron/preload'

/** 渲染进程访问 Electron 主进程的唯一入口；非 Electron 环境下（纯浏览器预览）降级为 no-op */
type MaybeApi = Partial<ElectronApi>

const api: MaybeApi = (window as unknown as { api?: MaybeApi }).api ?? {}

export const hasElectron = !!api.listWindows

/** 有没有「全屏框选」能力：纯浏览器里没有，UI 据此决定是否显示该按钮 */
export const hasRegionPicker = !!api.selectRegion

/** 有没有全局热键能力：纯浏览器里没有，实例页据此隐藏「热键」分区 */
export const hasGlobalHotkeys = !!api.syncHotkeys

/** 有没有系统目录选择框：没有时知识库页让用户手填路径（并提示这是降级） */
export const hasFolderPicker = !!api.selectFolder

/** 有没有系统文件选择框：没有时表格体检页让用户手填路径（并提示这是降级） */
export const hasWorkbookPicker = !!api.selectWorkbook

export const ipc = {
  listWindows: async () => (api.listWindows ? api.listWindows() : []),
  openInstance: async (p: { id: string; tool: string; name: string; route?: string }) =>
    api.openInstance ? api.openInstance(p) : false,
  closeInstance: async (id: string) => (api.closeInstance ? api.closeInstance(id) : false),
  userData: async () => (api.userData ? api.userData() : ''),
  showItem: async (p: string) => (api.showItem ? api.showItem(p) : false),
  /** 打开目录：没有 Electron 桥时返回 false，调用方提示用户手填路径 */
  openPath: async (p: string) => (api.openPath ? api.openPath(p) : false),
  /** 框选区域：没有 Electron 桥时返回 null，调用方提示用户改用上传 */
  selectRegion: async () => (api.selectRegion ? api.selectRegion() : null),
  /** 选目录：没有 Electron 桥时返回 null，调用方退回手填路径 */
  selectFolder: async () => (api.selectFolder ? api.selectFolder() : null),
  /** 选表格文件：没有 Electron 桥时返回 null，调用方退回手填路径 */
  selectWorkbook: async () => (api.selectWorkbook ? api.selectWorkbook() : null),

  /** 同步全部实例的热键注册表；返回注册结果，失败项要在 UI 上说出来 */
  syncHotkeys: async (bindings: HotkeyBinding[]) =>
    api.syncHotkeys ? api.syncHotkeys(bindings) : { registered: [], failed: [] },
  hotkeyStatus: async () =>
    api.hotkeyStatus
      ? api.hotkeyStatus()
      : { bindings: [] as HotkeyBinding[], failed: [] as string[], lastFocusedInstanceId: null },

  onHotkey: (cb: (a: HotkeyAction) => void) => (api.onHotkey ? api.onHotkey(cb) : () => {}),
  onHotkeyRouted: (cb: (info: HotkeyRouted) => void) => (api.onHotkeyRouted ? api.onHotkeyRouted(cb) : () => {}),
}

export type { WindowInfo, Region, HotkeyAction, HotkeyBinding, HotkeyRouted } from '../../electron/preload'
