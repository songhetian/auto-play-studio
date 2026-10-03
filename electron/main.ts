import { app, BrowserWindow, dialog, ipcMain, globalShortcut, shell, screen, Menu, nativeTheme } from 'electron'
import type { IpcMainEvent } from 'electron'
import { spawn, ChildProcess } from 'node:child_process'
import { exec } from 'node:child_process'
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
let consoleWindow: BrowserWindow | null = null
let engineProcess: ChildProcess | null = null

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
  return { registered, failed: failedAccels }
}

const isDev = !app.isPackaged
const ENGINE_PORT = 8731

/**
 * 窗口底色：跟随系统深色偏好。
 * 渲染进程要在 React 挂载后才写 <html data-theme>，之前那一帧的底色由这里决定，
 * 配合 show:false + ready-to-show，就不会出现「先白一下再变深色」的闪屏。
 */
const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#1A1A1E' : '#F7F8FA')

function createConsoleWindow() {
  // 控制台全局只有一个：已存在就直接聚焦，避免重复创建
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.focus()
    return consoleWindow
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: windowBg(),
    title: 'AutoPlay 控制台',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  })
  win.loadURL(isDev ? 'http://localhost:5173/#/' : `file://${path.join(__dirname, '../dist/index.html')}#/`)
  win.once('ready-to-show', () => win.show())
  consoleWindow = win
  return win
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
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

function startEngine() {
  if (engineProcess) return
  // 数据统一落 userData：打包后 cwd 不可写，也不该把 db / 素材写进安装目录
  const userData = app.getPath('userData')
  const env = {
    ...process.env,
    AUTOPLAY_DB: path.join(userData, 'autoplay.db'),
    AUTOPLAY_ASSETS_DIR: path.join(userData, 'image_assets'),
  }
  if (isDev) {
    const cwd = path.join(__dirname, '..', 'python')
    engineProcess = spawn('python', ['-m', 'uvicorn', 'engine.main:app', '--port', String(ENGINE_PORT)], {
      cwd,
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
  } else {
    // 打包态：跑 PyInstaller 打出的引擎 sidecar（最终用户无需安装 Python）
    const exe = path.join(process.resourcesPath, 'engine', 'autoplay-engine.exe')
    engineProcess = spawn(exe, [], { stdio: 'ignore', windowsHide: true, env })
  }
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
  const owner = BrowserWindow.getFocusedWindow() ?? consoleWindow
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
  const owner = BrowserWindow.getFocusedWindow() ?? consoleWindow
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

app.whenReady().then(() => {
  const win = createConsoleWindow()
  // 焦点回到控制台时清掉「最近实例」线索，避免 F9 打到已经不看的那一个
  win.on('focus', () => {
    lastFocusedInstanceId = null
  })

  startEngine()
  Menu.setApplicationMenu(null)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  engineProcess?.kill()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* ── IPC ── */
ipcMain.handle('windows:list', listWindows)
ipcMain.handle('app:userData', () => app.getPath('userData'))
ipcMain.handle('engine:port', () => ENGINE_PORT)
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
ipcMain.handle('workbook:select', () => selectWorkbook())

/* ── 快捷键 ── */
ipcMain.handle('hotkeys:sync', (_e, bindings: HotkeyBinding[]) => syncHotkeys(bindings ?? []))
ipcMain.handle('hotkeys:status', () => ({
  bindings: hotkeyBindings,
  failed: failedAccels,
  lastFocusedInstanceId,
}))
