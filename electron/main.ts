import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  globalShortcut,
  shell,
  screen,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  Notification,
  clipboard,
} from 'electron'
import type { IpcMainEvent } from 'electron'
import { createNotifyPump, type OutboxItem } from './notifications'
import { spawn, ChildProcess } from 'node:child_process'
import { exec } from 'node:child_process'
import { createEngineSupervisor } from './engineSupervisor'
import { createWindowHolder } from './windowRegistry'
import { captureForeground, insertText, realDeps, sendEnter, sendPaste, sendTyped, type InsertChannel } from './phraseFocus'
import { FIRST_REPLY_CATEGORY, pickFirstReply, type PhraseLike } from './firstReply'
import { captureSelection, selectionToQuery } from './sessionText'
import path from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/** 每个实例一个独立窗口：独立 BrowserWindow + 独立渲染上下文，互不干扰 */
const instanceWindows = new Map<string, BrowserWindow>()
/**
 * 控制台单例窗口。
 *
 * 用 holder 而不是裸变量：窗口关掉后对象还在但 `isDestroyed()` 为真，
 * 此时调 focus()/show()/setTitle() 会抛 "Object has been destroyed" ——
 * 之前通知泵每轮都对着已销毁的控制台窗口调 setTitle()，角标/标题静默停更。
 */
const consoleWindowRef = createWindowHolder<BrowserWindow>()
/**
 * 悬浮球窗口：置顶透明小窗，常驻桌面（控制台关掉也还在）。
 * 三态（监控中/告警/离线）由渲染层算，主进程只管：窗口在、能拖、点击回到控制台。
 */
const orbWindowRef = createWindowHolder<BrowserWindow>()
/** 窗口边长（含一圈透明边距，给告警光晕扩散留空间，避免被窗口裁掉） */
const ORB_WINDOW_SIZE = 84

/**
 * 话术速查面板：热键唤起的小窗（与悬浮球相互独立）。
 *
 * 应用级全局热键固定为 `Ctrl + Alt + P` —— **必须避让实例级的 F8 / F9 / F10**：
 * 那三个键在自动化跑起来时是"暂停 / 停止"的救命入口，被话术面板抢走就出事了。
 */
const PHRASE_PANEL_ACCEL = 'CommandOrControl+Alt+P'
const PHRASE_PANEL_LABEL = 'Ctrl + Alt + P'

/**
 * 知识库速填：与话术速查**共用同一个面板窗口**，只是换了入口与出口 ——
 * 知识库命中排在前，Enter 把内容填进事先框定的客服输入框。
 *
 * 为什么不另开一个面板：两个窗口功能重到九成，维护成本却翻倍，
 * 客服还得记住"该按哪个键开哪个窗"。共用窗口、模式不同，认知负担最小。
 *
 * 选 `Ctrl + Alt + K`（Knowledge）：同样避让实例级 F8/F9/F10 与 P/R/S 三个键。
 * 这一步的危险在"发送"而不在"填入" —— 落进输入框的字客服看得见、也删得掉。
 */
const KB_PANEL_ACCEL = 'CommandOrControl+Alt+K'
const KB_PANEL_LABEL = 'Ctrl + Alt + K'

/** 面板尺寸与落位：像输入法候选框，放屏幕上方居中，别挡住聊天输入区 */
const PHRASE_PANEL_W = 560
const PHRASE_PANEL_H = 420

/** 面板的两种入口。语义与渲染层 `PanelMode` 一致，决定排序与 Enter 行为 */
type PanelMode = 'phrase' | 'kb'

/**
 * 半自动首响：一键把"开场白"送进当前聊天输入框。
 *
 * 选 `Ctrl + Alt + R`（Response）：同样避让实例级 F8/F9/F10 与话术面板的 Ctrl+Alt+P。
 * 这条链路**不弹窗、不抢焦点**（只写剪贴板 + 发一次 Ctrl+V），所以唤起前不用记句柄 ——
 * 聊天窗口一直是前台，粘贴就落在它的输入框里。发不发由客服自己按回车决定。
 */
const FIRST_REPLY_ACCEL = 'CommandOrControl+Alt+R'
const FIRST_REPLY_LABEL = 'Ctrl + Alt + R'
/** 插入后是否自动回车发送。默认 false —— 发出去的话必须由人负责 */
let firstReplyAutoSend = false
/** 首响注入通道。默认粘贴（快、稳）；禁用粘贴的客户端可在托盘切到模拟输入 */
let firstReplyChannel: InsertChannel = 'paste'

/**
 * 选区自动建议：框住客户那句话 → 按热键 → 弹出按这句匹配的话术候选。
 *
 * 选 `Ctrl + Alt + S`（Select）。这一刻焦点还在聊天窗口上，所以**必须先把选区读出来**
 * 再显示面板 —— 面板一出来焦点就跑了，那时再问"你选了什么"就晚了。
 */
const SUGGEST_ACCEL = 'CommandOrControl+Alt+S'
const SUGGEST_LABEL = 'Ctrl + Alt + S'

const phrasePanelWindowRef = createWindowHolder<BrowserWindow>()
/** 面板当前处于哪种模式；决定「再按一次」是收起还是就地换模式 */
let phrasePanelMode: PanelMode = 'phrase'
/** 唤起面板**之前**记下的目标窗口句柄，插入时还焦点用；没记到为 null */
let phraseTargetHwnd: number | null = null
/** 设备层依赖：PowerShell 执行 + 等待（见 phraseFocus.ts） */
const phraseDeps = realDeps()
/**
 * 引擎可达性（悬浮球离线态的真源）。通知泵只报变化，这里留当前值 ——
 * 悬浮球窗口可能在信号发出后才加载完，挂载时要能问一次"现在在线吗"。
 */
let orbOnline = true
/** 托盘：常驻入口。控制台关掉后从这里找回或退出 */
let tray: Tray | null = null
/** 是否正在显式退出（区别于"只是关了窗口"）；window-all-closed 据此决定要不要收摊 */
let quitting = false
/** 引擎 sidecar：拉起 / 退出 / 报错都在这里收口（spawn 的 error 是异步的，必须挂监听） */
const engine = createEngineSupervisor({
  spawn: spawnEngine,
  onError: (err) => console.error('[engine] 启动失败：', err),
})

/* ── 快捷键注册表 ─────────────────────────────────────────────
 *
 * 控制台把「全部实例 × 各自的热键」同步过来，主进程只按唯一按键注册一次，
 * 再把按下事件**确定性地**路由到一个实例。
 *
 * 为什么不按焦点走：自动化跑起来时焦点在目标程序上，
 * BrowserWindow.getFocusedWindow() 拿不到我们的窗口，热键就静默失效了。
 */
type HotkeyAction = 'run' | 'toggle' | 'stop'

interface HotkeyBinding {
  accel: string
  action: HotkeyAction
  instanceId: string
  instanceName: string
  tool: string
  scope: 'window' | 'tool'
  /** 实例当前是否在跑：决定窗口没开时要不要为它拉起窗口 */
  live: boolean
}

let hotkeyBindings: HotkeyBinding[] = []
/** 最近一次获得焦点的实例窗口，作为「焦点不在我们这边」时的路由依据 */
let lastFocusedInstanceId: string | null = null
/** 窗口还没加载完就按下的键，先排队，did-finish-load 后补发 */
const pendingHotkeys = new Map<string, HotkeyAction[]>()
/** 注册失败（被别的程序占了）的按键，回给设置页提示 */
let failedAccels: string[] = []

const instanceIdOfWindow = (win: BrowserWindow | null): string | null => {
  if (!win) return null
  for (const [id, w] of instanceWindows) if (w === win) return id
  return null
}

/**
 * 同一按键被多个实例占用时的挑选顺序：
 *   焦点实例 > 最近用过的实例 > 在跑的实例 > 按键名排序后的第一个
 * 只影响「按下去谁响应」，不会同时作用到多个实例 —— 除非该实例自己选了 tool 作用域。
 */
function pickTarget(candidates: HotkeyBinding[]): HotkeyBinding | null {
  if (!candidates.length) return null
  const byId = (id: string | null) => candidates.find((b) => b.instanceId === id)
  return (
    byId(instanceIdOfWindow(BrowserWindow.getFocusedWindow())) ??
    byId(lastFocusedInstanceId) ??
    candidates.find((b) => b.live) ??
    [...candidates].sort((a, b) => a.instanceId.localeCompare(b.instanceId))[0]
  )
}

function deliverHotkey(instanceId: string, action: HotkeyAction) {
  const win = instanceWindows.get(instanceId)
  if (win) {
    win.webContents.send('hotkey', action)
    return
  }
  const b = hotkeyBindings.find((x) => x.instanceId === instanceId)
  if (!b) return
  // 开始键要能把窗口拉起来（空闲实例的窗口通常是关着的，不然 F8 就成了摆设）；
  // 暂停/停止只对「已经在跑」的实例才有意义 —— 没在跑就没得停。
  if (action !== 'run' && !b.live) return
  // 窗口没开但实例在跑：为它把运行窗口拉起来，再把按键补发过去
  pendingHotkeys.set(instanceId, [...(pendingHotkeys.get(instanceId) ?? []), action])
  createInstanceWindow({ id: instanceId, tool: b.tool, name: b.instanceName, route: `/instance/${instanceId}/run` })
}

function dispatchHotkey(accel: string) {
  const candidates = hotkeyBindings.filter((b) => b.accel === accel)
  const target = pickTarget(candidates)
  if (!target) return

  // window 作用域只打这一个实例；tool 作用域才扩散到同工具的其它实例
  const targets =
    target.scope === 'tool' ? candidates.filter((b) => b.tool === target.tool) : [target]
  for (const t of targets) deliverHotkey(t.instanceId, target.action)

  // 有冲突就告诉用户命中了谁，避免以为「全都暂停了」
  if (candidates.length > 1) {
    const win = instanceWindows.get(target.instanceId)
    win?.webContents.send('hotkey:routed', {
      accel,
      action: target.action,
      chosen: target.instanceName,
      others: candidates.filter((b) => b.instanceId !== target.instanceId).map((b) => b.instanceName),
      scope: target.scope,
    })
  }
}

function syncHotkeys(bindings: HotkeyBinding[]): { registered: string[]; failed: string[] } {
  hotkeyBindings = bindings
  globalShortcut.unregisterAll()
  failedAccels = []

  const accels = [...new Set(bindings.map((b) => b.accel))]
  const registered: string[] = []
  for (const accel of accels) {
    try {
      // 重复注册会被系统忽略，所以这里按去重后的按键逐个注册
      if (globalShortcut.register(accel, () => dispatchHotkey(accel))) registered.push(accel)
      else failedAccels.push(accel)
    } catch {
      failedAccels.push(accel)
    }
  }
  // 重新注册应用级按键：上面那句 unregisterAll 把它们一并抹掉了
  registerAppHotkeys()
  return { registered, failed: failedAccels }
}

const isDev = !app.isPackaged
const ENGINE_PORT = 8731

/**
 * preload 需要引擎端口来拼绝对地址（打包态渲染进程是 file://，相对路径不可用）。
 * 用 additionalArguments 同步注入，而不是再开一条 async IPC：端口在启动时就定死了，
 * 让每个调用点 await 一次既没必要，也容易漏。
 */
const preloadWebPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  additionalArguments: [`--engine-port=${ENGINE_PORT}`],
})

/**
 * 窗口底色：跟随系统深色偏好。
 * 渲染进程要在 React 挂载后才写 <html data-theme>，之前那一帧的底色由这里决定，
 * 配合 show:false + ready-to-show，就不会出现「先白一下再变深色」的闪屏。
 */
const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#1A1A1E' : '#F7F8FA')

function createConsoleWindow() {
  // 控制台全局只有一个：已存在就直接聚焦，避免重复创建
  const existing = consoleWindowRef.get()
  if (existing) {
    existing.focus()
    return existing
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: windowBg(),
    title: 'AutoPlay 控制台',
    webPreferences: preloadWebPreferences(),
  })
  win.loadURL(isDev ? 'http://localhost:5173/#/' : `file://${path.join(__dirname, '../dist/index.html')}#/`)
  win.once('ready-to-show', () => win.show())
  // 关闭后自动置空由 holder 负责（不必每个窗口都记得手写一遍）
  return consoleWindowRef.set(win)
}

/** 把控制台叫到前台：已存在就恢复/聚焦，没有就新建。托盘与悬浮球共用 */
function showConsole() {
  const win = createConsoleWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * 悬浮球窗口（移植 desk 桌面端形态）。
 *
 * 置顶、透明、无边框、不进任务栏 —— 员工机上的"常驻小挂件"。
 * 初始落主屏右下角；用户可拖动（拖动逻辑在主进程，见 orb:drag-*）。
 */
function createOrbWindow() {
  const existing = orbWindowRef.get()
  if (existing) return existing
  const wa = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({
    width: ORB_WINDOW_SIZE,
    height: ORB_WINDOW_SIZE,
    x: wa.x + wa.width - ORB_WINDOW_SIZE - 24,
    y: wa.y + wa.height - ORB_WINDOW_SIZE - 24,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: '监控悬浮球',
    webPreferences: preloadWebPreferences(),
  })
  win.setAlwaysOnTop(true, 'floating')
  win.loadURL(isDev ? 'http://localhost:5173/#/orb' : `file://${path.join(__dirname, '../dist/index.html')}#/orb`)
  // showInactive：启动时不抢走用户正在输入的那个窗口的焦点
  win.once('ready-to-show', () => win.showInactive())
  return orbWindowRef.set(win)
}

/** 悬浮球右键菜单：找回控制台 / 藏起球 / 退出。退出是常驻形态下唯一的"关进程"入口之一 */
function showOrbMenu(win: BrowserWindow) {
  Menu.buildFromTemplate([
    { label: '打开控制台', click: () => showConsole() },
    {
      label: '隐藏悬浮球',
      click: () => win.hide(),
    },
    { type: 'separator' },
    { label: '退出 AutoPlay', click: () => app.quit() },
  ]).popup({ window: win })
}

/**
 * 话术速查面板窗口。透明无边框、不进任务栏、置顶 ——
 * 唤起时抢焦点好让客服直接打字，插入时再把焦点还给聊天窗口。
 */
function createPhrasePanelWindow() {
  const existing = phrasePanelWindowRef.get()
  if (existing) return existing
  const wa = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({
    width: PHRASE_PANEL_W,
    height: PHRASE_PANEL_H,
    x: Math.round(wa.x + (wa.width - PHRASE_PANEL_W) / 2),
    y: Math.round(wa.y + wa.height * 0.16),
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: '话术速查',
    webPreferences: preloadWebPreferences(),
  })
  win.setAlwaysOnTop(true, 'floating')
  win.loadURL(
    isDev
      ? 'http://localhost:5173/#/phrases-quick'
      : `file://${path.join(__dirname, '../dist/index.html')}#/phrases-quick`,
  )
  // 点到别处就收起：候选框的直觉行为，也避免长期盖在聊天输入区上
  win.on('blur', () => {
    if (!quitting) win.hide()
  })
  return phrasePanelWindowRef.set(win)
}

/**
 * 显示并聚焦面板。
 *
 * `seed` 非空表示「选区建议」，把它带给渲染层当检索依据；
 * `mode` 决定渲染层的列表排序与 Enter 行为，两件事都随这一次唤起一次性送到，
 * 渲染层不需要自己判断"我这次是被谁唤起来的"。
 */
function openPhrasePanel(seed = '', mode: PanelMode = 'phrase') {
  const win = createPhrasePanelWindow()
  phrasePanelMode = mode
  // 无边框窗口看不到标题，但任务管理器 / 托盘悬停会显示，值得说准
  win.setTitle(mode === 'kb' ? '知识库速填' : '话术速查')
  win.show()
  win.focus()
  const notify = () => win.webContents.send('phrase-panel:open', { seed, mode })
  // 首次唤起时窗口可能还在加载，挂一次 did-finish-load 免得信号丢失
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', notify)
  else notify()
}

/**
 * 热键行为：没开就开；已经开着且在前台**且是同一个键**就收起（再按一次切换）。
 *
 * 换成另一个键时不收起而是就地切模式 —— 客服按了 K 就是要找知识库，
 * 先把面板关掉、再让他重按一次，纯属添乱。
 *
 * 关键在**先记下前台窗口**再显示面板 —— 面板一出来焦点就被抢走，那时再问就晚了。
 */
async function togglePhrasePanel(mode: PanelMode = 'phrase') {
  const win = createPhrasePanelWindow()
  if (win.isVisible() && win.isFocused() && phrasePanelMode === mode) {
    win.hide()
    return
  }
  phraseTargetHwnd = await captureForeground(phraseDeps)
  openPhrasePanel('', mode)
}

/**
 * 取话术库（供首响挑选）。主进程直连引擎 —— 与通知泵一个路子，不必绕渲染层。
 */
async function fetchPhrases(): Promise<Array<PhraseLike & { id: number }>> {
  const r = await fetch(`http://127.0.0.1:${ENGINE_PORT}/api/phrases`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as Array<PhraseLike & { id: number }>
}

/** 去掉首尾空白、行尾统一成 `\n`：粘进聊天框才不会多出空行（与话术面板同一取舍） */
function normalizeBody(body: string): string {
  return String(body ?? '').replace(/\r\n?/g, '\n').trim()
}

/**
 * 半自动首响：挑一条开场白，送进**当前前台窗口**的输入框。
 *
 * **默认不发送** —— 只把文字放进输入框，客服看一眼再自己按回车。
 * 这条链路刻意不弹窗、不记句柄、不还焦点：聊天窗口一直是前台，
 * 粘贴自然落在它的输入框里；而"还焦点"要 `SW_RESTORE`，
 * 会把最大化的聊天窗口缩回去，反而帮倒忙。
 */
async function insertFirstReply() {
  let rows: Array<PhraseLike & { id: number }>
  try {
    rows = await fetchPhrases()
  } catch (err) {
    console.error('[first-reply] 取话术失败：', err)
    new Notification({ title: '首响没取到话术', body: '连不上引擎，检查服务是否在运行' }).show()
    return
  }
  const pick = pickFirstReply(rows)
  if (!pick) {
    new Notification({ title: '还没有首响话术', body: `到「话术库」加一条，归到「${FIRST_REPLY_CATEGORY}」分类` }).show()
    return
  }
  const text = normalizeBody(pick.phrase.body)
  if (!text) return

  if (firstReplyChannel === 'type') {
    await sendTyped(text, phraseDeps)
  } else {
    clipboard.writeText(text)
    await sendPaste(phraseDeps)
  }
  if (firstReplyAutoSend) await sendEnter(phraseDeps)

  // 记一次使用：按下去用了这条，就是最好的"常用度"信号（失败不影响插入）
  const id = rows.find((r) => r === pick.phrase)?.id
  if (id != null) {
    void fetch(`http://127.0.0.1:${ENGINE_PORT}/api/phrases/${id}/use`, { method: 'POST' }).catch(() => {})
  }
}

/**
 * 选区自动建议：把框住的客户消息带进话术面板做检索依据。
 *
 * 顺序不能反：**先读选区、再弹面板**。面板一显示就抢走焦点，
 * 那时 UIA 问到的"当前选区"已经是面板自己的输入框了。
 * 读不到选区也照样开面板（降级成手动搜），只是多一句提示。
 */
async function suggestFromSelection() {
  const selected = await captureSelection(phraseDeps, {
    read: () => clipboard.readText(),
    write: (t) => clipboard.writeText(t),
  })
  const seed = selectionToQuery(selected)
  if (!seed) {
    new Notification({
      title: '没读到选中的文字',
      body: `先在聊天窗口里框住客户那句话，再按 ${SUGGEST_LABEL}`,
    }).show()
  }
  phraseTargetHwnd = await captureForeground(phraseDeps)
  openPhrasePanel(seed)
}

/**
 * 应用级全局按键（与实例无关）。
 *
 * 必须在 `syncHotkeys` 的 `unregisterAll()` 之后**重新注册** ——
 * 否则控制台每同步一次实例热键，话术面板的键就被悄悄抹掉了。
 */
function registerAppHotkeys() {
  const apps: Array<[string, () => void]> = [
    [PHRASE_PANEL_ACCEL, () => void togglePhrasePanel('phrase')],
    [KB_PANEL_ACCEL, () => void togglePhrasePanel('kb')],
    [FIRST_REPLY_ACCEL, () => void insertFirstReply()],
    [SUGGEST_ACCEL, () => void suggestFromSelection()],
  ]
  for (const [accel, run] of apps) {
    try {
      // 注册失败 = 键被别的程序占了，或与实例热键撞了；要回给设置页提示，不能静默
      if (!globalShortcut.register(accel, run)) failedAccels.push(accel)
    } catch {
      failedAccels.push(accel)
    }
  }
}

/**
 * 托盘（常驻入口）。
 *
 * 图标在构建时生成（`electron/tray.png`，一个与悬浮球同色的靛蓝实心圆）——
 * 桌面小组件不该因为缺一个位图就整个功能哑掉。
 */
function createTray() {
  if (tray) return tray
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'))
  tray = new Tray(icon)
  tray.setToolTip('AutoPlay · 监控常驻')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开控制台', click: () => showConsole() },
      {
        label: '显示悬浮球',
        click: () => {
          createOrbWindow().showInactive()
        },
      },
      { label: `话术速查（${PHRASE_PANEL_LABEL}）`, click: () => void togglePhrasePanel('phrase') },
      { label: `知识库速填（${KB_PANEL_LABEL}）`, click: () => void togglePhrasePanel('kb') },
      { label: `选区建议（${SUGGEST_LABEL}）`, click: () => void suggestFromSelection() },
      { label: `首响一句话（${FIRST_REPLY_LABEL}）`, click: () => void insertFirstReply() },
      // 默认不勾：插入后只**放进输入框**，客服自己回车；勾上才会替他按发送
      {
        label: '首响：插入后自动发送',
        type: 'checkbox',
        checked: firstReplyAutoSend,
        click: (mi) => {
          firstReplyAutoSend = mi.checked
        },
      },
      // 个别客户端禁用粘贴，切这条用"逐字敲"送进去
      {
        label: '首响：改用模拟输入',
        type: 'checkbox',
        checked: firstReplyChannel === 'type',
        click: (mi) => {
          firstReplyChannel = mi.checked ? 'type' : 'paste'
        },
      },
      { type: 'separator' },
      { label: '退出 AutoPlay', click: () => app.quit() },
    ]),
  )
  // 左键单击：直接回到控制台（Windows 上托盘图标最常用的动作）
  tray.on('click', () => showConsole())
  return tray
}

function createInstanceWindow(payload: { id: string; tool: string; name: string; route?: string }) {
  const existing = instanceWindows.get(payload.id)
  if (existing) {
    existing.focus()
    return existing
  }
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    show: false,
    backgroundColor: windowBg(),
    title: `${payload.name} · ${payload.id}`,
    webPreferences: preloadWebPreferences(),
  })
  const route = payload.route ?? `/instance/${payload.id}/config`
  win.loadURL(isDev ? `http://localhost:5173/#${route}` : `file://${path.join(__dirname, '../dist/index.html')}#${route}`)
  win.once('ready-to-show', () => win.show())

  // 路由依据之一：谁最近被聚焦过
  win.on('focus', () => {
    lastFocusedInstanceId = payload.id
  })
  // 窗口是热键按下来才拉起来的，按键先排在队列里，加载完立刻补发
  win.webContents.on('did-finish-load', () => {
    const queued = pendingHotkeys.get(payload.id)
    if (!queued) return
    pendingHotkeys.delete(payload.id)
    for (const action of queued) win.webContents.send('hotkey', action)
  })

  win.on('closed', () => instanceWindows.delete(payload.id))
  instanceWindows.set(payload.id, win)
  return win
}

/** Windows：通过 PowerShell 枚举带窗口标题的进程 */
async function listWindows(): Promise<Array<{ title: string; process: string; pid: number; windows: number; state: string }>> {
  if (process.platform !== 'win32') return []
  const ps = `Get-Process | Where-Object {$_.MainWindowTitle -ne ""} | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json`
  try {
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`, { windowsHide: true })
    const raw = stdout.trim()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return arr.map((p: any) => ({
      title: p.MainWindowTitle,
      process: `${p.ProcessName}.exe`,
      pid: Number(p.Id),
      windows: 1,
      state: '后台',
    }))
  } catch {
    return []
  }
}

/** 真正拉起引擎进程：dev 走本机 python，打包态走 PyInstaller 打的 sidecar */
function spawnEngine(): ChildProcess {
  // 数据统一落 userData：打包后 cwd 不可写，也不该把 db / 素材写进安装目录
  const userData = app.getPath('userData')
  const env = {
    ...process.env,
    AUTOPLAY_DB: path.join(userData, 'autoplay.db'),
    AUTOPLAY_ASSETS_DIR: path.join(userData, 'image_assets'),
  }
  if (isDev) {
    const cwd = path.join(__dirname, '..', 'python')
    return spawn('python', ['-m', 'uvicorn', 'engine.main:app', '--port', String(ENGINE_PORT)], {
      cwd,
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
  }
  // 打包态：跑 PyInstaller 打出的引擎 sidecar（最终用户无需安装 Python）
  const exe = path.join(process.resourcesPath, 'engine', 'autoplay-engine.exe')
  return spawn(exe, [], { stdio: 'ignore', windowsHide: true, env })
}

function startEngine() {
  // 幂等：已在跑就直接返回；引擎中途退出会自动置空，下次调用能重新拉起
  engine.ensureRunning()
}

/**
 * 全屏遮罩框选：返回选中区域（屏幕物理像素）；用户按 Esc 或直接关掉返回 null。
 *
 * 遮罩铺在「当前窗口所在的那块显示器」上，坐标是 DIP（CSS px）。
 * Python 侧截屏拿到的是物理像素，所以在多屏缩放不同的机器上要乘上该显示器的缩放比。
 * 单屏或各屏缩放一致时这就是精确值。
 */
function selectRegion(): Promise<Region | null> {
  return new Promise((resolve) => {
    const owner = BrowserWindow.getFocusedWindow()
    const display = owner ? screen.getDisplayMatching(owner.getBounds()) : screen.getPrimaryDisplay()
    const bounds = display.bounds

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      hasShadow: false,
      webPreferences: { preload: path.join(__dirname, 'region-preload.js'), contextIsolation: true },
    })
    win.setAlwaysOnTop(true, 'screen-saver')

    let settled = false
    const finish = (region: Region | null) => {
      if (settled) return
      settled = true
      ipcMain.removeListener('region:result', onResult)
      if (!win.isDestroyed()) win.close()
      resolve(region)
    }

    const onResult = (event: IpcMainEvent, rect: Region | null) => {
      if (event.sender !== win.webContents) return // 只认这块遮罩发回来的
      if (!rect) return finish(null)
      const scale = display.scaleFactor || 1
      finish({
        x: Math.round((bounds.x + rect.x) * scale),
        y: Math.round((bounds.y + rect.y) * scale),
        width: Math.round(rect.width * scale),
        height: Math.round(rect.height * scale),
      })
    }

    ipcMain.on('region:result', onResult)
    win.on('closed', () => finish(null))
    win.loadFile(path.join(__dirname, 'region.html'))
  })
}

/**
 * 选一个目录。知识库要「登记一个文件夹」—— 让用户手打绝对路径太容易打错，
 * 而且错在哪他看不出来（登记成功了，只是永远扫不出文件）。
 *
 * 取消返回 null。默认目录给「我的文档」，比给 C 盘根目录更像人会选的地方。
 */
async function selectFolder(): Promise<string | null> {
  const owner = BrowserWindow.getFocusedWindow() ?? consoleWindowRef.get()
  const options = {
    title: '选择要加入知识库的文件夹',
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    defaultPath: app.getPath('documents'),
  }
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
}

/**
 * 弹系统文件选择框，只要 Excel 工作簿。
 *
 * 过滤器挡在老版 .xls 与 csv 外面：这条链路上读表的是 openpyxl，它两个都不认，
 * 放进来只会让用户看到一个「文件读不了」的报错，却不知道该改什么。
 * 取消返回 null。默认目录给「我的文档」—— 客服的表大多在那儿。
 */
async function selectWorkbook(): Promise<string | null> {
  const owner = BrowserWindow.getFocusedWindow() ?? consoleWindowRef.get()
  const options = {
    title: '选择要体检的表格',
    properties: ['openFile'] as Array<'openFile'>,
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx', 'xlsm'] }],
    defaultPath: app.getPath('documents'),
  }
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
}

/* ── 桌面通知（工单 02 · S4）────────────────────────────────
 *
 * 引擎是 sidecar，自己弹不了 Windows 通知；而监控是常驻盯屏的，没人会一直开着窗口等着看。
 * 所以由**主进程**（跟着应用常驻）定时去引擎的 outbox 取 —— 窗口关了也照样收得到。
 *
 * 真弹窗与角标是设备层，只人工验收；「取 → 弹 → 计数」这条链路在 `notifications.ts`，
 * 四个外部依赖全是注入点，有单测。
 */
const CONSOLE_TITLE = 'AutoPlay 控制台'

/**
 * 命中提醒补一声系统提示音：原生 Windows 通知本身不发声（尤其静音/专注模式下），
 * 监控场景"没听见"等于"没报警"。用系统自带音效文件，零依赖、跨机器可用。
 * 走异步 Play，不阻塞通知泵的轮询线程。
 */
function playAlertSound() {
  if (process.platform !== 'win32') return
  const wav = 'C:\\Windows\\Media\\Windows Notify System Generic.wav'
  exec(`powershell -NoProfile -Command "(New-Object Media.SoundPlayer '${wav}').Play()"`, () => {})
}

function startNotifyPump() {
  const base = `http://127.0.0.1:${ENGINE_PORT}`
  return createNotifyPump({
    fetchOutbox: async (since) => {
      const r = await fetch(`${base}/api/notifications/outbox?since=${since}`)
      if (!r.ok) throw new Error(`outbox ${r.status}`)
      return (await r.json()) as { items: OutboxItem[]; cursor: number }
    },
    fetchUnread: async () => {
      const r = await fetch(`${base}/api/hit-events/unread-count`)
      if (!r.ok) throw new Error(`unread-count ${r.status}`)
      return ((await r.json()) as { count: number }).count
    },
    show: (item) => {
      const n = new Notification({ title: item.title, body: item.detail || undefined })
      // 点通知回到控制台：人是从通知过来的，下一步一定是看是哪条命中了
      n.on('click', () => showConsole())
      n.show()
      // 监控命中补一声提示音：原生通知不发声，静音模式下尤其容易错过
      playAlertSound()
      // 悬浮球同步脉冲红光（3s 后自动回常态）—— 常驻挂件的第一信号
      orbWindowRef.get()?.webContents.send('orb:pulse', { level: item.level, title: item.title })
    },
    setBadge: (count) => {
      // 只在 macOS / Linux 生效；Windows 上没有可用的角标 API
      // （setBadgeCount 是空操作，做 overlay 或托盘又需要先有图标资源），
      // 所以 Windows 上把未读数写进窗口标题 —— 任务栏上看得到。
      app.setBadgeCount(count)
      const win = consoleWindowRef.get()
      if (process.platform === 'win32' && win) {
        win.setTitle(count > 0 ? `${CONSOLE_TITLE} · ${count} 条未读` : CONSOLE_TITLE)
      }
    },
    // 引擎可达性变化 → 悬浮球切在线/离线态（离线时不显示"监控中"，免得误导）
    onEngine: (online) => {
      orbOnline = online
      orbWindowRef.get()?.webContents.send('orb:online', online)
    },
    // 引擎刚起来那几秒取不到是常态：静默，下一轮自然就好，绝不能让泵停摆
    onError: () => {},
  })
}

let notifyPump: { stop: () => void } | null = null

app.whenReady().then(() => {
  // 打包后通知要显示应用名，靠的就是这个 AppUserModelID（开发环境无影响）
  app.setAppUserModelId('com.autoplay.studio')
  const win = createConsoleWindow()
  // 焦点回到控制台时清掉「最近实例」线索，避免 F9 打到已经不看的那一个
  win.on('focus', () => {
    lastFocusedInstanceId = null
  })

  startEngine()
  // 悬浮球 + 托盘 + 话术面板：常驻形态。先建窗口再起泵，泵首轮的可达性信号才有人接。
  createOrbWindow()
  createTray()
  createPhrasePanelWindow()
  // 应用级热键（话术速查）。实例热键由控制台同步，这里只注册与实例无关的那一个
  registerAppHotkeys()
  notifyPump = startNotifyPump()
  Menu.setApplicationMenu(null)
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  notifyPump?.stop()
  engine.stop()
})

app.on('window-all-closed', () => {
  // 常驻形态：关掉窗口 ≠ 退出。悬浮球 / 托盘还在，监控要继续跑；
  // 只有显式退出（托盘或悬浮球菜单 → app.quit）才收摊。
  if (process.platform === 'darwin' || quitting) return
  // 兜底：万一托盘没建起来（理论上不会），仍按老行为退出，免得用户关不掉进程
  if (!tray) app.quit()
})

/* ── IPC ── */
ipcMain.handle('windows:list', listWindows)
ipcMain.handle('app:userData', () => app.getPath('userData'))
ipcMain.handle('instance:open', (_e, payload) => {
  createInstanceWindow(payload)
  return true
})
ipcMain.handle('instance:close', (_e, id: string) => {
  instanceWindows.get(id)?.close()
  return true
})
ipcMain.handle('instance:list', () => Array.from(instanceWindows.keys()))
ipcMain.handle('shell:showItem', (_e, fullPath: string) => {
  shell.showItemInFolder(fullPath)
  return true
})
ipcMain.handle('shell:openPath', async (_e, dir: string) => {
  await shell.openPath(dir)
  return true
})
ipcMain.handle('region:select', () => selectRegion())
ipcMain.handle('folder:select', () => selectFolder())
/**
 * 通用选文件：只给扩展名白名单，由渲染层决定要什么类型。
 *
 * 为什么不用 selectWorkbook 顶替：它的过滤器写死了 xlsx/xlsm，
 * 拿它选 JSON 会让用户看到"只能选 Excel" —— 看着像坏了。
 */
async function selectFile(accept?: string): Promise<string | null> {
  const owner = BrowserWindow.getFocusedWindow() ?? consoleWindowRef.get()
  const exts = (accept || '')
    .split(';')
    .map((x) => x.replace(/^\./, '').trim())
    .filter(Boolean)
  const options = {
    title: exts.length ? `选择 ${exts.join(' / ')} 文件` : '选择文件',
    properties: ['openFile'] as Array<'openFile'>,
    filters: exts.length ? [{ name: exts.join(' / ').toUpperCase(), extensions: exts }] : [],
    defaultPath: app.getPath('documents'),
  }
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
}

ipcMain.handle('workbook:select', () => selectWorkbook())
ipcMain.handle('file:select', (_e, accept?: string) => selectFile(accept))

/* ── 快捷键 ── */
ipcMain.handle('hotkeys:sync', (_e, bindings: HotkeyBinding[]) => syncHotkeys(bindings ?? []))
ipcMain.handle('hotkeys:status', () => ({
  bindings: hotkeyBindings,
  failed: failedAccels,
  lastFocusedInstanceId,
}))

/* ── 悬浮球 ──
 *
 * 拖动放在主进程而不是 CSS `-webkit-app-region: drag`：
 * drag 区域会把鼠标点击也吃掉，球就成了"只能拖不能点"。
 * 这里由渲染层上报 **屏幕坐标**，主进程算位移再 setPosition ——
 * 用屏幕坐标（e.screenX/Y）而不是窗口内坐标，拖动中球自身在动也不影响计算。
 */
let orbDrag: { mouseX: number; mouseY: number; winX: number; winY: number } | null = null

ipcMain.handle('orb:state', () => ({ online: orbOnline }))
ipcMain.handle('orb:activate', () => {
  showConsole()
  return true
})
ipcMain.on('orb:menu', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (win) showOrbMenu(win)
})
ipcMain.on('orb:drag-start', (e, p: { x: number; y: number }) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  const [winX, winY] = win.getPosition()
  orbDrag = { mouseX: p.x, mouseY: p.y, winX, winY }
})
ipcMain.on('orb:drag-move', (e, p: { x: number; y: number }) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win || !orbDrag) return
  win.setPosition(Math.round(orbDrag.winX + (p.x - orbDrag.mouseX)), Math.round(orbDrag.winY + (p.y - orbDrag.mouseY)))
})
ipcMain.on('orb:drag-end', () => {
  orbDrag = null
})

/* ── 话术速查面板 ──
 *
 * 插入链路（写剪贴板 → 藏面板 → 还焦点 → Ctrl+V）在 `phraseFocus.ts`，
 * 这里只把真实依赖接上去。目标句柄是唤起面板那一刻记下的（`phraseTargetHwnd`）。
 */
ipcMain.handle('phrase:insert', async (_e, payload: { text?: string } = {}) => {
  await insertText(String(payload?.text ?? ''), phraseTargetHwnd, {
    ...phraseDeps,
    writeClipboard: (t) => clipboard.writeText(t),
    hidePanel: () => phrasePanelWindowRef.get()?.hide(),
  })
  // 本次用完即失效：下次唤起前会重新记，避免误粘到上一次的目标窗口
  phraseTargetHwnd = null
  return true
})
ipcMain.handle('phrase:close', () => {
  phrasePanelWindowRef.get()?.hide()
  return true
})
/** 面板页脚展示用（键名只有主进程知道，渲染层问一次即可） */
ipcMain.handle('phrase:hotkey', () => PHRASE_PANEL_LABEL)
ipcMain.handle('kb:hotkey', () => KB_PANEL_LABEL)
/** 设置页要一次列全应用级全局键：各自问一次请求太碎，这里一次给全 */
ipcMain.handle('app:hotkeys', () => ({
  phrase: PHRASE_PANEL_LABEL,
  kb: KB_PANEL_LABEL,
  firstReply: FIRST_REPLY_LABEL,
  suggest: SUGGEST_LABEL,
}))
