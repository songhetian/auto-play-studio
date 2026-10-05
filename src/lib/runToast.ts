export type ControlAction = 'start' | 'pause' | 'resume' | 'stop'

const CONTROL_TEXT: Record<ControlAction, string> = {
  start: '已开始执行',
  pause: '已暂停',
  resume: '已继续执行',
  stop: '已停止',
}

/**
 * 运行控制的一句话回执。
 *
 * 列表里的按钮、实例窗口的按钮、全局热键都走这里 —— 同一句文案只写一遍，
 * 也保证「点了按钮」这件事永远有回应，不再是一按就没了动静。
 */
export function controlToastText(action: ControlAction): string {
  return CONTROL_TEXT[action]
}
