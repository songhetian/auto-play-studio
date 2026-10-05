/**
 * 选区取文本（坐席辅助第④步：选区自动建议的第一步）。
 *
 * 目标：拿到客服"刚框住的那句话"，交给话术检索当建议依据。
 *
 * 两条路，按可靠性排序：
 *  1. **选区为主**：用 UI Automation 直接问系统"当前选了什么"。最准，
 *     且完全不碰用户的剪贴板；
 *  2. **剪贴板兜底**：UIA 对自绘界面（很多聊天客户端）不生效，此时模拟一次
 *     Ctrl+C 把选区复制出来 —— 代价是会写剪贴板，所以**先存后还**。
 *
 * 设备调用（PowerShell / 剪贴板）只在员工机人工验收；这里把依赖注入，
 * 于是"顺序对不对、剪贴板还没还"这些真正会错的地方都能单测。
 */
import type { FocusDeps } from './phraseFocus'

/** 用 UIA 读当前焦点元素的选中文本；读不到就吐空串（交给调用方兜底） */
export const SELECTION_SCRIPT = [
  'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes',
  '$e=[System.Windows.Automation.AutomationElement]::FocusedElement',
  'if($e -ne $null){$p=$e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)',
  '($p.GetSelection()|ForEach-Object{$_.GetText(-1)}) -join [char]10}',
].join('; ')

/** 模拟一次 Ctrl+C（剪贴板兜底用） */
export const COPY_SCRIPT = `(New-Object -ComObject WScript.Shell).SendKeys('^c'); 'ok'`

/** 按下 Ctrl+C 后等剪贴板写完的时间 */
export const COPY_SETTLE_MS = 120

/** 剪贴板读写（注入点：主进程用 Electron 的 clipboard） */
export interface ClipDeps {
  read: () => string
  write: (text: string) => void
}

/** UIA 直接读选区。失败/不支持一律返回空串，不抛 */
export async function readSelection(deps: FocusDeps): Promise<string> {
  try {
    return (await deps.run(SELECTION_SCRIPT)).trim()
  } catch {
    return ''
  }
}

function safeRead(clips: ClipDeps): string {
  try {
    return clips.read() ?? ''
  } catch {
    return ''
  }
}

/**
 * 取当前选中文本：先用 UIA，拿不到再模拟 Ctrl+C 走剪贴板。
 *
 * 判定"兜底有没有成功"的办法是**比较前后剪贴板是否变化**：
 * 目标窗口没有选中内容时，Ctrl+C 什么也不做，剪贴板维持原样 ——
 * 这时若把旧剪贴板当选区返回，就等于拿用户上次复制的东西去搜话术，纯属误导。
 */
export async function captureSelection(deps: FocusDeps, clips: ClipDeps): Promise<string> {
  const byUia = await readSelection(deps)
  if (byUia) return byUia

  const saved = safeRead(clips)
  try {
    await deps.run(COPY_SCRIPT)
    await deps.delay(COPY_SETTLE_MS)
    const got = safeRead(clips)
    return got !== saved ? got.trim() : ''
  } catch {
    return ''
  } finally {
    if (saved) {
      try {
        clips.write(saved)
      } catch {
        /* 还原剪贴板失败也只能认了，不能因此让整个功能崩 */
      }
    }
  }
}

/** 一句话查询的长度上限：太长当查询词反而谁也匹配不上 */
export const SELECTION_QUERY_MAX = 120

/**
 * 把一段选区变成"可检索的一句话"。
 *
 * 取**最后一行**：客服往往连着框住好几条消息，真正要回的是最新那条。
 * 把整段当查询词，检索结果会被旧消息带偏，甚至什么都匹配不到。
 */
export function selectionToQuery(text: string): string {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (!lines.length) return ''
  return lines[lines.length - 1].slice(0, SELECTION_QUERY_MAX)
}