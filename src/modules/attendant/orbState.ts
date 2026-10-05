/**
 * 悬浮球状态机（移植 desk 桌面端形态，纯逻辑、时钟注入，便于测试）。
 *
 * 四态：常态（监控中）· 告警（命中违禁词）· 待处理（有告警超时未确认）· 离线（词库/引擎不可用）。
 *
 * 四条规则（前三条与 C# 侧 `OrbStateController` 一致，保证两个端"是同一个产品"）：
 *  1. **离线优先**：一旦离线，无论是否命中都显示离线，直至恢复在线；
 *  2. **告警短促**：命中后红光仅维持 `alertDurationMs`（默认 3s）即自动回常态，
 *     不常亮 —— 守住"不打扰"；反复命中只刷新窗口，不叠加；
 *  3. **离线期间脉冲不残留**：离线时来的命中直接丢弃，恢复在线即从常态起算。
 *  4. **待处理常驻**：存在"未确认且已超响应时限"的命中时，球常亮待处理态并带条数角标。
 *     这是对规则 2 的补充 —— 红光 3 秒错过了，也不该当无事发生。它排在告警之后：
 *     新命中（刚出事）比旧账（还没人确认）更紧急，先报新的。
 *
 * 视觉（呼吸/脉冲的相位、颜色插值）属于渲染层，不在这里 ——
 * 这一层只回答"此刻该是哪一态"。
 */

/** 悬浮球四态 */
export type OrbState = 'normal' | 'alert' | 'pending' | 'offline'

/** 告警态默认持续时长（毫秒） */
export const ORB_ALERT_MS = 3000

export class OrbStateMachine {
  private readonly alertDurationMs: number
  private online = true
  /** 告警截止时刻（毫秒时间戳）；MinValue 语义用 0 表示 */
  private alertUntil = 0
  /** 超时未确认的命中条数（由调用方按 `dispositionOf` 统计后喂进来），0 = 无待处理 */
  private pendingCount = 0

  constructor(alertDurationMs: number = ORB_ALERT_MS) {
    this.alertDurationMs = alertDurationMs
  }

  /** 标记词库/引擎是否在线。false → 立刻离线；true → 退出离线态 */
  setOnline(online: boolean): void {
    this.online = online
  }

  /**
   * 命中违禁词时调用，使球进入告警态直至 `now + alertDurationMs`。
   * 离线期间调用会被忽略（不残留）。
   */
  pulseAlert(now: number): void {
    if (!this.online) return
    this.alertUntil = now + this.alertDurationMs
  }

  /**
   * 更新"超时未确认"条数（角标显示的数字）。
   * 负数/小数/NaN 都按 0 或取整处理：这种脏值只会来自统计处的意外，
   * 不该让球显示 `-1` 这种数字，也不该因为一个 NaN 就把状态卡住。
   */
  setPending(count: number): void {
    this.pendingCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  }

  /** 当前待处理条数（供角标渲染） */
  pending(): number {
    return this.pendingCount
  }

  /** 返回当前应显示的状态 */
  currentState(now: number): OrbState {
    if (!this.online) return 'offline'
    if (now < this.alertUntil) return 'alert'
    return this.pendingCount > 0 ? 'pending' : 'normal'
  }
}