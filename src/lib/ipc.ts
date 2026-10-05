import type {
  AppHotkeyLabels,
  ElectronApi,
  HotkeyAction,
  HotkeyBinding,
  HotkeyRouted,
  OrbHit,
  PhrasePanelOpen,
} from '../../electron/preload'

/** 渲染进程访问 Electron 主进程的唯一入口；非 Electron 环境下（纯浏览器预览）降级为 no-op */
type MaybeApi = Partial<ElectronApi>

/**
 * **每次调用时**才读 `window.api`，不能在模块加载时快照一次。
 *
 * preload 注入的时机不一定早于渲染层模块求值（dev 模式下模块被并行加载、
 * 自动化测试里更是可以先 import 再注入假桥）。快照一次会让「本来有桥」被误判成
 * 「没桥」，于是点配置毫无反应 —— 表现为按钮坏了，实际是判断早了。
 */
const bridge = (): MaybeApi => (window as unknown as { api?: MaybeApi }).api ?? {}

const has = (k: keyof ElectronApi) => !!bridge()[k]

/** 跑在真正的 Electron 里（而不是浏览器预览 / 测试环境） */
export const hasElectron = has('listWindows')

/** 有没有「全屏框选」能力：纯浏览器里没有，UI 据此决定是否显示该按钮 */
export const hasRegionPicker = has('selectRegion')

/** 有没有全局热键能力：纯浏览器里没有，实例页据此隐藏「热键」分区 */
export const hasGlobalHotkeys = has('syncHotkeys')

/** 有没有系统目录选择框：没有时知识库页让用户手填路径（并提示这是降级） */
export const hasFolderPicker = has('selectFolder')

/** 有没有系统文件选择框：没有时表格体检页让用户手填路径（并提示这是降级） */
export const hasWorkbookPicker = has('selectWorkbook')

/** 有没有应用级全局热键：没有（浏览器预览）时设置页不列这一组 —— 主进程不在，这些键不存在 */
export const hasAppHotkeys = has('appHotkeys')

const notOpened = false

export const ipc = {
  listWindows: async () => {
    const a = bridge()
    return a.listWindows ? a.listWindows() : []
  },
  openInstance: async (p: { id: string; tool: string; name: string; route?: string }) => {
    const a = bridge()
    return a.openInstance ? a.openInstance(p) : notOpened
  },
  closeInstance: async (id: string) => {
    const a = bridge()
    return a.closeInstance ? a.closeInstance(id) : notOpened
  },
  userData: async () => {
    const a = bridge()
    return a.userData ? a.userData() : ''
  },
  /** 引擎端口：主进程经 preload 同步注入；非 Electron 环境（浏览器预览 / 单测）为 null */
  enginePort: () => bridge().enginePort ?? null,
  showItem: async (p: string) => {
    const a = bridge()
    return a.showItem ? a.showItem(p) : notOpened
  },
  /** 打开目录：没有 Electron 桥时返回 false，调用方提示用户手填路径 */
  openPath: async (p: string) => {
    const a = bridge()
    return a.openPath ? a.openPath(p) : notOpened
  },
  /** 框选区域：没有 Electron 桥时返回 null，调用方提示用户改用上传 */
  selectRegion: async () => {
    const a = bridge()
    return a.selectRegion ? a.selectRegion() : null
  },
  /** 选目录：没有 Electron 桥时返回 null，调用方退回手填路径 */
  selectFolder: async () => {
    const a = bridge()
    return a.selectFolder ? a.selectFolder() : null
  },
  /** 选表格文件：没有 Electron 桥时返回 null，调用方退回手填路径 */
  selectWorkbook: async () => {
    const a = bridge()
    return a.selectWorkbook ? a.selectWorkbook() : null
  },
  /** 选任意类型文件：accept 形如 'json'。没有桥时返回 null */
  selectFile: async (p?: { accept?: string }) => {
    const a = bridge()
    return a.selectFile ? a.selectFile(p?.accept) : null
  },
  /**
   * `File` → 绝对路径。没有桥（浏览器预览）时返回空串。
   * 浏览器出于安全不把磁盘位置暴露给 JS，所以这条只能走 preload。
   */
  getPathForFile: (file: File): string => {
    const a = bridge()
    return a.getPathForFile ? a.getPathForFile(file) : ''
  },

  /** 同步全部实例的热键注册表；返回注册结果，失败项要在 UI 上说出来 */
  syncHotkeys: async (bindings: HotkeyBinding[]) => {
    const a = bridge()
    return a.syncHotkeys ? a.syncHotkeys(bindings) : { registered: [], failed: [] }
  },
  hotkeyStatus: async () => {
    const a = bridge()
    return a.hotkeyStatus
      ? a.hotkeyStatus()
      : { bindings: [] as HotkeyBinding[], failed: [] as string[], lastFocusedInstanceId: null }
  },

  onHotkey: (cb: (a: HotkeyAction) => void) => {
    const a = bridge()
    return a.onHotkey ? a.onHotkey(cb) : () => {}
  },
  onHotkeyRouted: (cb: (info: HotkeyRouted) => void) => {
    const a = bridge()
    return a.onHotkeyRouted ? a.onHotkeyRouted(cb) : () => {}
  },

  /* ── 悬浮球 ── */
  onOrbPulse: (cb: (hit: OrbHit) => void) => {
    const a = bridge()
    return a.onOrbPulse ? a.onOrbPulse(cb) : () => {}
  },
  onOrbOnline: (cb: (online: boolean) => void) => {
    const a = bridge()
    return a.onOrbOnline ? a.onOrbOnline(cb) : () => {}
  },
  /** 挂载时问一次在线态；没有桥（浏览器预览）时按在线处理 */
  orbState: async () => {
    const a = bridge()
    return a.orbState ? a.orbState() : { online: true }
  },
  /** 单击 → 打开控制台；无桥时不起作用 */
  orbActivate: async () => {
    const a = bridge()
    return a.orbActivate ? a.orbActivate() : notOpened
  },
  orbMenu: () => {
    bridge().orbMenu?.()
  },
  orbDragStart: (x: number, y: number) => {
    bridge().orbDragStart?.(x, y)
  },
  orbDragMove: (x: number, y: number) => {
    bridge().orbDragMove?.(x, y)
  },
  orbDragEnd: () => {
    bridge().orbDragEnd?.()
  },

  /* ── 话术速查面板 ── */
  /**
   * 热键唤起面板：渲染层据此重置查询、聚焦输入框。
   * `payload.seed` 非空 = 这次是「选区建议」，把选中的客户消息带进来当检索依据；
   * `payload.mode` 决定这次是话术速查还是知识库速填（缺省按话术处理）。
   */
  onPhrasePanelOpen: (cb: (payload: PhrasePanelOpen) => void) => {
    const a = bridge()
    return a.onPhrasePanelOpen ? a.onPhrasePanelOpen(cb) : () => {}
  },
  /** 把文本插进唤起前的目标窗口；没有 Electron 桥时返回 false（只复制，不粘贴） */
  insertPhrase: async (text: string) => {
    const a = bridge()
    return a.insertPhrase ? a.insertPhrase(text) : notOpened
  },
  /** 收起面板；没有 Electron 桥时不做任何事 */
  closePhrasePanel: async () => {
    const a = bridge()
    return a.closePhrasePanel ? a.closePhrasePanel() : notOpened
  },
  /** 面板页脚展示的热键名；没有桥时为空串 */
  phraseHotkey: async () => {
    const a = bridge()
    return a.phraseHotkey ? a.phraseHotkey() : ''
  },
  /** 知识库速填的热键名；没有桥时为空串（调用方据此整条不展示） */
  kbPanelHotkey: async () => {
    const a = bridge()
    return a.kbPanelHotkey ? a.kbPanelHotkey() : ''
  },
  /**
   * 一次取全应用级全局键名，给设置页列清单。
   *
   * 没有桥时返回空串的 labels 而不是抛错：这些键**本来就不存在**
   * （浏览器预览里没有主进程），调用方该做的是整块不显示，而不是报错。
   */
  appHotkeys: async (): Promise<AppHotkeyLabels> => {
    const a = bridge()
    return a.appHotkeys ? a.appHotkeys() : { phrase: '', kb: '', firstReply: '', suggest: '' }
  },
  /** 复制文字到系统剪贴板；没有 Electron 桥时返回 false */
  copyText: (text: string): boolean => {
    const a = bridge()
    return a.copyText ? a.copyText(text) : false
  },
}

export type {
  WindowInfo,
  Region,
  HotkeyAction,
  HotkeyBinding,
  HotkeyRouted,
  OrbHit,
  PhrasePanelOpen,
  AppHotkeyLabels,
} from '../../electron/preload'
