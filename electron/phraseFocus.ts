/**
 * 「把话术送进目标窗口」的 Windows 设备层。
 *
 * 场景：客服正在某个聊天客户端里打字，按热键唤出速查面板，选一条话术 ——
 * 这条文本要落进**原来那个聊天输入框**，而不是我们自己的面板里。
 *
 * 三条现实约束决定了做法：
 *  1. 面板一显示就抢走了焦点，所以必须在唤起**之前**记下前台窗口句柄，
 *     插入时再把它还回去；
 *  2. 目标程序是任意第三方客户端，没有任何可对接的注入接口 ——
 *     唯一通用且零依赖的办法是：写剪贴板 + 给对方发一次 Ctrl+V；
 *  3. 纯本地、不联网、不引入原生插件（robotjs 之类），所以走 PowerShell。
 *
 * 设备层只在员工机上人工验收；这里把 `run` / `delay` / `writeClipboard` 全做成注入点，
 * 于是"顺序对不对、句柄有没有传对"这类真正会错的地方都能单测。
 */
import { exec } from 'node:child_process'

/** 设备层依赖（注入点） */
export interface FocusDeps {
  /** 执行一段 PowerShell 脚本，回 stdout */
  run: (script: string) => Promise<string>
  /** 短暂等待：给"面板让出焦点""焦点已还回去"留出生效时间 */
  delay: (ms: number) => Promise<void>
}

/** user32 的 P/Invoke 声明。每次调用都要 Add-Type 一次（无状态、无残留） */
const USER32 = [
  'Add-Type -Namespace Ap -Name Win -MemberDefinition ',
  `'[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();`,
  `[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);`,
  `[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);'`,
].join('')

/** 取当前前台窗口句柄 */
export const CAPTURE_SCRIPT = `${USER32}; [Ap.Win]::GetForegroundWindow().ToInt64()`

/** 把焦点还回指定窗口（先 SW_RESTORE=9，最小化的窗口也能拉回来） */
export function restoreScript(hwnd: number): string {
  return `${USER32}; [Ap.Win]::ShowWindow([IntPtr]${hwnd}, 9) | Out-Null; [Ap.Win]::SetForegroundWindow([IntPtr]${hwnd}) | Out-Null; 'ok'`
}

/** 给当前前台窗口发一次 Ctrl+V */
export const PASTE_SCRIPT = `(New-Object -ComObject WScript.Shell).SendKeys('^v'); 'ok'`

/**
 * SendKeys 的元字符：`+`（Shift）`^`（Ctrl）`%`（Alt）`~`（回车）`()`（分组）
 * 以及用作按键码语法的 `{}`。它们**必须**转义，否则一句话术里出现 `+`
 * 就会被当成按住 Shift，后面的字符全变样。
 *
 * 方括号不在其列：把 `[` 写成 `{[}` 反而会被当成"按下 [ 键"的按键码而报错。
 */
const SENDKEYS_SPECIAL = /[+^%~(){}]/g

/**
 * 把字面文本转成 SendKeys 可安全发送的形式：
 * 元字符各套一层大括号（`{+}`），换行统一成 `{ENTER}`。
 */
export function escapeSendKeys(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(SENDKEYS_SPECIAL, (c) => `{${c}}`)
    .replace(/\n/g, '{ENTER}')
}

/**
 * 模拟输入脚本：把整段文字逐字"敲"进焦点窗口。
 * 单引号在 PowerShell 里成对括起字符串，文本里的单个 `'` 要写成 `''`。
 */
export function typeScript(text: string): string {
  const literal = escapeSendKeys(text).replace(/'/g, "''")
  return `(New-Object -ComObject WScript.Shell).SendKeys('${literal}'); 'ok'`
}

/**
 * 注入通道。
 *  - `paste`：写剪贴板 + Ctrl+V。默认，快且稳，但个别客户端禁用粘贴；
 *  - `type`：SendKeys 逐字敲。慢，但粘贴被禁时是唯一能用的路。
 */
export type InsertChannel = 'paste' | 'type'

/** 按当前前台窗口发一次模拟输入。尽力而为，不抛 */
export async function sendTyped(text: string, deps: FocusDeps): Promise<void> {
  try {
    await deps.run(typeScript(text))
  } catch {
    /* 设备层尽力而为 */
  }
}

/**
 * 给当前前台窗口发一次回车（= 按下发送）。
 * 只在用户**显式**打开"插入后自动发送"时才用 —— 默认不发送，发出去的话得由人负责。
 */
export const ENTER_SCRIPT = `(New-Object -ComObject WScript.Shell).SendKeys('{ENTER}'); 'ok'`

export async function sendEnter(deps: FocusDeps): Promise<void> {
  try {
    await deps.run(ENTER_SCRIPT)
  } catch {
    /* 设备层尽力而为 */
  }
}

/** 默认设备实现：把 PowerShell 用 Base64（UTF-16LE）编码后执行，彻底绕开引号转义问题 */
export function realDeps(): FocusDeps {
  return {
    run: (script) =>
      new Promise((resolve, reject) => {
        const encoded = Buffer.from(script, 'utf16le').toString('base64')
        exec(
          `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
          { windowsHide: true },
          (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
        )
      }),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

/**
 * 记下当前前台窗口句柄。取不到返回 null ——
 * 那只是退化成"粘贴给当前焦点窗口"，不该让整个插入失败。
 */
export async function captureForeground(deps: FocusDeps): Promise<number | null> {
  try {
    const out = (await deps.run(CAPTURE_SCRIPT)).trim()
    if (!/^\d+$/.test(out)) return null
    const hwnd = Number(out)
    return Number.isSafeInteger(hwnd) && hwnd > 0 ? hwnd : null
  } catch {
    return null
  }
}

/** 把焦点还给目标窗口。尽力而为：还不了也别抛，用户顶多需要手动点一下输入框 */
export async function restoreForeground(hwnd: number, deps: FocusDeps): Promise<void> {
  try {
    await deps.run(restoreScript(hwnd))
  } catch {
    /* 设备层尽力而为 */
  }
}

/** 发一次 Ctrl+V。同样尽力而为 */
export async function sendPaste(deps: FocusDeps): Promise<void> {
  try {
    await deps.run(PASTE_SCRIPT)
  } catch {
    /* 设备层尽力而为 */
  }
}

/** 插入编排所需依赖 */
export interface InsertDeps extends FocusDeps {
  writeClipboard: (text: string) => void
  hidePanel: () => void
}

/** 面板让出焦点 / 焦点还回去之后，各留一小段生效时间（毫秒） */
export const BLUR_SETTLE_MS = 90
export const REFOCUS_SETTLE_MS = 70

/**
 * 把话术文本送进目标窗口。顺序不能变：
 *   写剪贴板 → 藏面板 → （等它让出焦点）→ 还焦点 → （等焦点生效）→ Ctrl+V
 *
 * `target` 为 null（唤起前没记到句柄）时跳过还焦点，直接粘给当前焦点窗口。
 */
export async function insertText(text: string, target: number | null, deps: InsertDeps): Promise<void> {
  deps.writeClipboard(text)
  deps.hidePanel()
  if (target != null) {
    await deps.delay(BLUR_SETTLE_MS)
    await restoreForeground(target, deps)
    await deps.delay(REFOCUS_SETTLE_MS)
  }
  await sendPaste(deps)
}