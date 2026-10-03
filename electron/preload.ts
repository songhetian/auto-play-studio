import { contextBridge, ipcRenderer } from 'electron'

export interface WindowInfo {
  title: string
  process: string
  pid: number
  windows: number
  state: string
}

export interface Region {
  x: number
  y: number
  width: number
  height: number
}

export type HotkeyAction = 'run' | 'toggle' | 'stop'

/** 控制台同步给主进程的一条热键绑定 */
export interface HotkeyBinding {
  accel: string
  action: HotkeyAction
  instanceId: string
  instanceName: string
  tool: string
  scope: 'window' | 'tool'
  live: boolean
}

/** 同一按键被多个实例占用时，主进程回执「这次打给了谁」 */
export interface HotkeyRouted {
  accel: string
  action: HotkeyAction
  chosen: string
  others: string[]
  scope: 'window' | 'tool'
}

const api = {
  listWindows: (): Promise<WindowInfo[]> => ipcRenderer.invoke('windows:list'),
  openInstance: (payload: { id: string; tool: string; name: string; route?: string }): Promise<boolean> =>
    ipcRenderer.invoke('instance:open', payload),
  closeInstance: (id: string): Promise<boolean> => ipcRenderer.invoke('instance:close', id),
  listInstances: (): Promise<string[]> => ipcRenderer.invoke('instance:list'),
  userData: (): Promise<string> => ipcRenderer.invoke('app:userData'),
  enginePort: (): Promise<number> => ipcRenderer.invoke('engine:port'),
  showItem: (p: string): Promise<boolean> => ipcRenderer.invoke('shell:showItem', p),
  /** 在系统文件管理器里打开一个目录（设置页的「打开数据目录」用） */
  openPath: (p: string): Promise<boolean> => ipcRenderer.invoke('shell:openPath', p),
  /** 拉一块全屏遮罩让用户框选区域；取消返回 null */
  selectRegion: (): Promise<Region | null> => ipcRenderer.invoke('region:select'),
  /** 弹系统目录选择框（知识库登记文件夹用）；取消返回 null */
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('folder:select'),
  /** 弹系统文件选择框，只要 .xlsx / .xlsm（表格体检用）；取消返回 null */
  selectWorkbook: (): Promise<string | null> => ipcRenderer.invoke('workbook:select'),

  /** 控制台把「全部实例的热键」推给主进程；返回实际注册成功的按键与失败清单 */
  syncHotkeys: (bindings: HotkeyBinding[]): Promise<{ registered: string[]; failed: string[] }> =>
    ipcRenderer.invoke('hotkeys:sync', bindings),
  hotkeyStatus: (): Promise<{ bindings: HotkeyBinding[]; failed: string[]; lastFocusedInstanceId: string | null }> =>
    ipcRenderer.invoke('hotkeys:status'),

  /** 实例窗口收按键。toggle = 暂停/继续之间切，stop = 停止 */
  onHotkey: (cb: (action: HotkeyAction) => void) => {
    const handler = (_e: unknown, action: HotkeyAction) => cb(action)
    ipcRenderer.on('hotkey', handler)
    return () => ipcRenderer.removeListener('hotkey', handler)
  },
  /** 按键存在冲突时主进程的说明：这次打给了谁、还有谁也绑了同一个键 */
  onHotkeyRouted: (cb: (info: HotkeyRouted) => void) => {
    const handler = (_e: unknown, info: HotkeyRouted) => cb(info)
    ipcRenderer.on('hotkey:routed', handler)
    return () => ipcRenderer.removeListener('hotkey:routed', handler)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronApi = typeof api
