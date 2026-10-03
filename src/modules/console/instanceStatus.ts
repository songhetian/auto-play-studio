import type { InstanceStatus } from '@/schemas/instance'

/** 实例状态的中文名与语义色，总览 / 实例管理 / 工具页共用一份，避免各处口径不一 */

export const STATUS_TEXT: Record<InstanceStatus, string> = {
  idle: '空闲',
  starting: '启动中',
  running: '运行中',
  paused: '已暂停',
  stopping: '停止中',
  completed: '已完成',
  error: '异常',
  armed: '布防中',
}

export function statusTone(s: InstanceStatus): 'ok' | 'err' | 'warn' | 'neutral' {
  if (s === 'running' || s === 'armed') return 'ok'
  if (s === 'error') return 'err'
  if (s === 'paused' || s === 'starting' || s === 'stopping') return 'warn'
  return 'neutral'
}

/** 「活跃」= 已经起来但还没结束，总览的 KPI 与列表都按这个口径 */
export const LIVE_STATUSES: InstanceStatus[] = ['starting', 'running', 'paused', 'stopping', 'armed']

export const isLive = (s: InstanceStatus) => LIVE_STATUSES.includes(s)
