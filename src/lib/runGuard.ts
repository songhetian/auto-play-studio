import type { Instance } from '@/schemas/instance'

/**
 * 执行前确认文案：把所有「会真实动手」的细节摊在确认框里，逼用户看一眼再点。
 *
 * 这是「安全护栏」的第一道：rpa / macro 会真实操作目标窗口（输入文本 / 按键 / 回写 Excel），
 * 等于把话术发给人或动了别人的文件。点「开始执行」之前必须先确认「动的是哪个窗口、动多少行」。
 *
 * monitor / logi / cmp 不碰键鼠、不发消息，无需这道确认，返回 null（调用方直接开始）。
 */
export interface RunConfirm {
  title: string
  desc: string
  confirmText: string
}

export function buildRunConfirm(inst: Instance): RunConfirm | null {
  const cfg = inst.config
  if (cfg.tool === 'rpa') {
    const r = cfg.rpa
    const rows = Math.max(0, (r.to || 1) - (r.from || 1) + 1)
    const win = cfg.window || '（未绑定窗口）'
    return {
      title: '确认开始执行？',
      desc: `将向窗口「${win}」逐行发送，共 ${rows} 行。执行期间会真实输入文本 / 按键、并回写 Excel 状态列，请确认目标窗口无误。`,
      confirmText: '开始执行',
    }
  }
  if (cfg.tool === 'macro') {
    const n = cfg.macro.cmds.length
    const win = cfg.window || '（未绑定窗口）'
    return {
      title: '确认执行一次？',
      desc: `将在窗口「${win}」按顺序执行 ${n} 条指令（按键 / 输入）。整轮会真实操作该窗口。`,
      confirmText: '执行一次',
    }
  }
  return null
}
