import { contextBridge, ipcRenderer } from 'electron'
import * as electronNs from 'electron'

/**
 * Electron ≥32 才有的 webUtils；本项目跑在 31.x，取不到就退回旧的 `file.path`。
 * （32 起 `File.prototype.path` 被弃用，两条路都留着才能跨版本）
 */
const webUtils = (electronNs as unknown as { webUtils?: { getPathForFile(f: File): string } }).webUtils

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

/** 悬浮球的一次命中脉冲（主进程从通知泵转发） */
export interface OrbHit {
  level: string
  title: string
}

/** 热键唤起面板时随信号送来的上下文 */
export interface PhrasePanelOpen {
  /** 非空 = 选区建议：把选中的客户消息带进来当检索依据 */
  seed?: string
  /**
   * 这次是哪个键唤起的。缺省按 `'phrase'` 处理 ——
   * 老版本主进程不发这个字段，渲染层不能因此把面板弄成空白。
   */
  mode?: 'phrase' | 'kb'
}

/**
 * 应用级全局快捷键的键名。主进程是唯一事实来源 ——
 * 设置页、面板页脚都从这里取显示名，不在渲染层再抄一份（抄了迟早对不上）。
 */
export interface AppHotkeyLabels {
  /** 话术速查 */
  phrase: string
  /** 知识库速填 */
  kb: string
  /** 首响一句话 */
  firstReply: string
  /** 选区建议 */
  suggest: string
}

/**
 * 引擎端口：主进程用 `--engine-port=` 通过 additionalArguments 同步注入。
 *
 * 不写成 async IPC：拼地址（`apiBase`、`<img src>`、WebSocket URL）全是同步的，
 * 一个 Promise 会把所有调用点逼成异步。取不到（纯浏览器预览 / 单测）时为 null。
 */
const enginePort = (() => {
  const raw = process.argv.find((a) => a.startsWith('--engine-port='))
  const n = Number(raw?.slice('--engine-port='.length))
  return Number.isInteger(n) && n > 0 ? n : null
})()

const api = {
  listWindows: (): Promise<WindowInfo[]> => ipcRenderer.invoke('windows:list'),
  /** 通用选文件：accept 形如 'json' / 'xlsx;csv' */
  selectFile: (accept?: string): Promise<string | null> => ipcRenderer.invoke('file:select', accept),
  openInstance: (payload: { id: string; tool: string; name: string; route?: string }): Promise<boolean> =>
    ipcRenderer.invoke('instance:open', payload),
  closeInstance: (id: string): Promise<boolean> => ipcRenderer.invoke('instance:close', id),
  listInstances: (): Promise<string[]> => ipcRenderer.invoke('instance:list'),
  userData: (): Promise<string> => ipcRenderer.invoke('app:userData'),
  /** 引擎端口：主进程注入，同步可读（拼地址是同步的，不能是 Promise） */
  enginePort,
  showItem: (p: string): Promise<boolean> => ipcRenderer.invoke('shell:showItem', p),
  /** 在系统文件管理器里打开一个目录（设置页的「打开数据目录」用） */
  openPath: (p: string): Promise<boolean> => ipcRenderer.invoke('shell:openPath', p),
  /** 拉一块全屏遮罩让用户框选区域；取消返回 null */
  selectRegion: (): Promise<Region | null> => ipcRenderer.invoke('region:select'),
  /** 弹系统目录选择框（知识库登记文件夹用）；取消返回 null */
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('folder:select'),
  /** 弹系统文件选择框，只要 .xlsx / .xlsm（表格体检用）；取消返回 null */
  selectWorkbook: (): Promise<string | null> => ipcRenderer.invoke('workbook:select'),

  /**
   * `File` 对象 → **绝对路径**（拿不到时返回空串）。
   *
   * 为什么必须过 preload：渲染进程拿不到真实路径 ——
   * `webkitGetAsEntry().fullPath` 只是 `/售后资料` 这种虚拟路径，
   * 浏览器出于安全也不给 JS 暴露磁盘位置。只有这里（preload 上下文）能取到。
   */
  getPathForFile: (file: File): string => {
    try {
      if (webUtils) return webUtils.getPathForFile(file)
    } catch {
      /* 传进来的不是真 File 对象：落到下面的兜底 */
    }
    // Electron 31 及更早：File 带 path 属性（32 起弃用，但还能用）
    return (file as File & { path?: string }).path ?? ''
  },

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

  /* ── 悬浮球 ── */
  /** 命中违禁词：主进程推来脉冲，球据此亮 3 秒红光 */
  onOrbPulse: (cb: (hit: OrbHit) => void) => {
    const handler = (_e: unknown, hit: OrbHit) => cb(hit)
    ipcRenderer.on('orb:pulse', handler)
    return () => ipcRenderer.removeListener('orb:pulse', handler)
  },
  /** 引擎在线状态变化：false → 球进入离线态 */
  onOrbOnline: (cb: (online: boolean) => void) => {
    const handler = (_e: unknown, online: boolean) => cb(online)
    ipcRenderer.on('orb:online', handler)
    return () => ipcRenderer.removeListener('orb:online', handler)
  },
  /** 挂载时问一次当前在线态：推流只报变化，窗口加载晚一步就会漏掉 */
  orbState: (): Promise<{ online: boolean }> => ipcRenderer.invoke('orb:state'),
  /** 单击悬浮球 → 打开/聚焦控制台 */
  orbActivate: (): Promise<boolean> => ipcRenderer.invoke('orb:activate'),
  /** 右键悬浮球 → 弹原生菜单 */
  orbMenu: (): void => {
    ipcRenderer.send('orb:menu')
  },
  /** 拖动：上报屏幕坐标（screenX/screenY），主进程据此 setPosition */
  orbDragStart: (x: number, y: number): void => {
    ipcRenderer.send('orb:drag-start', { x, y })
  },
  orbDragMove: (x: number, y: number): void => {
    ipcRenderer.send('orb:drag-move', { x, y })
  },
  orbDragEnd: (): void => {
    ipcRenderer.send('orb:drag-end')
  },

  /* ── 话术速查面板 ── */
  /**
   * 热键唤起面板：渲染层收到后重置查询、聚焦输入框。
   * `seed` 非空时表示这次是「选区建议」——把选中的客户消息带进来当检索依据。
   */
  onPhrasePanelOpen: (cb: (payload: PhrasePanelOpen) => void) => {
    const handler = (_e: unknown, payload: PhrasePanelOpen = {}) => cb(payload)
    ipcRenderer.on('phrase-panel:open', handler)
    return () => ipcRenderer.removeListener('phrase-panel:open', handler)
  },
  /** 把文本插进唤起前的目标窗口（主进程：写剪贴板 + 还焦点 + Ctrl+V） */
  insertPhrase: (text: string): Promise<boolean> => ipcRenderer.invoke('phrase:insert', { text }),
  /** 收起面板（Esc / 插入后） */
  closePhrasePanel: (): Promise<boolean> => ipcRenderer.invoke('phrase:close'),
  /** 面板页脚展示的热键名（键名只有主进程知道） */
  phraseHotkey: (): Promise<string> => ipcRenderer.invoke('phrase:hotkey'),
  /** 知识库速填的热键名 */
  kbPanelHotkey: (): Promise<string> => ipcRenderer.invoke('kb:hotkey'),
  /** 一次取全应用级全局键名，给设置页列清单用 */
  appHotkeys: (): Promise<AppHotkeyLabels> => ipcRenderer.invoke('app:hotkeys'),
  /**
   * 复制一段文字到系统剪贴板（查到知识库摘要时，Enter 复制而非插入聊天框）。
   * 在 preload 上下文直接写，不绕主进程：剪贴板本就是渲染层能碰的东西。
   */
  copyText: (text: string): boolean => {
    try {
      electronNs.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  },
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronApi = typeof api
