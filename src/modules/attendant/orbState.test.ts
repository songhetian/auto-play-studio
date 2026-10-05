import { describe, expect, it } from 'vitest'
import { OrbStateMachine, ORB_ALERT_MS } from './orbState'

/**
 * 悬浮球状态机（移植 desk 桌面端形态）。
 *
 * 三态语义必须与员工机客户端一致，才谈得上"同一个产品"：
 *   常态（监控中）· 告警（命中违禁词，短促 3s）· 离线（词库/引擎不可用）。
 *
 * 时钟由调用方传入（注入 now），所以逻辑可测、不依赖真实计时器 ——
 * 与 C# 侧 `OrbStateController` 的取舍保持一致。
 */
describe('悬浮球状态机', () => {
  it('默认是常态', () => {
    const m = new OrbStateMachine()
    expect(m.currentState(0)).toBe('normal')
  })

  it('命中后进入告警态，并在时长内保持', () => {
    const m = new OrbStateMachine(3000)
    m.pulseAlert(1000)
    expect(m.currentState(1000)).toBe('alert')
    expect(m.currentState(3999)).toBe('alert')
  })

  it('告警到点自动回常态（边界取不到 = 常态）', () => {
    const m = new OrbStateMachine(3000)
    m.pulseAlert(1000)
    expect(m.currentState(4000)).toBe('normal')
  })

  it('离线优先：离线时命中也不亮告警，始终离线', () => {
    const m = new OrbStateMachine()
    m.setOnline(false)
    m.pulseAlert(1000)
    expect(m.currentState(1000)).toBe('offline')
    expect(m.currentState(1500)).toBe('offline')
  })

  it('离线期间的脉冲不残留：恢复在线即从常态起算', () => {
    const m = new OrbStateMachine(3000)
    m.setOnline(false)
    m.pulseAlert(1000)
    m.setOnline(true)
    expect(m.currentState(1001)).toBe('normal')
  })

  it('告警中途转离线：立即离线，不等脉冲走完', () => {
    const m = new OrbStateMachine(3000)
    m.pulseAlert(1000)
    expect(m.currentState(1000)).toBe('alert')
    m.setOnline(false)
    expect(m.currentState(1000)).toBe('offline')
  })

  it('默认告警时长 3 秒', () => {
    expect(ORB_ALERT_MS).toBe(3000)
    const m = new OrbStateMachine()
    m.pulseAlert(0)
    expect(m.currentState(ORB_ALERT_MS - 1)).toBe('alert')
    expect(m.currentState(ORB_ALERT_MS)).toBe('normal')
  })

  it('告警期间再次命中：刷新窗口，而不是叠加', () => {
    const m = new OrbStateMachine(3000)
    m.pulseAlert(1000)
    m.pulseAlert(2500)
    // 以最后一次命中的 2500 起算，5500 才结束
    expect(m.currentState(5000)).toBe('alert')
    expect(m.currentState(5500)).toBe('normal')
  })
})

/**
 * 第四态：待处理（时效预警）。
 *
 * 告警红光只有 3 秒，错过就"看起来什么都没发生" —— 但那条命中仍然没人确认。
 * 于是增加一个**常驻**的待处理态：只要存在「未确认且已超响应时限」的命中，
 * 球就一直提示，并在角标上显示条数。
 *
 * 优先级（离线 > 告警 > 待处理 > 常态）：
 *  - 离线时连不上引擎，谈待处理没有意义，先报离线；
 *  - 告警是"刚刚又出事了"，比"还有旧账没清"更紧急，短促红光优先；
 *  - 两者都不占时，才让待处理常驻。
 */
describe('悬浮球状态机 · 待处理态', () => {
  it('存在超时未确认的告警时进入待处理态', () => {
    const m = new OrbStateMachine()
    m.setPending(3)
    expect(m.currentState(0)).toBe('pending')
  })

  it('待处理数清零后回常态', () => {
    const m = new OrbStateMachine()
    m.setPending(2)
    expect(m.currentState(0)).toBe('pending')
    m.setPending(0)
    expect(m.currentState(0)).toBe('normal')
  })

  it('待处理数可读出（供角标显示）', () => {
    const m = new OrbStateMachine()
    m.setPending(5)
    expect(m.pending()).toBe(5)
  })

  it('离线优先于待处理', () => {
    const m = new OrbStateMachine()
    m.setPending(3)
    m.setOnline(false)
    expect(m.currentState(0)).toBe('offline')
  })

  it('待处理不因离线而丢失：恢复在线仍是待处理', () => {
    const m = new OrbStateMachine()
    m.setPending(3)
    m.setOnline(false)
    m.setOnline(true)
    expect(m.currentState(0)).toBe('pending')
  })

  it('告警短促优先于待处理：3 秒内显示告警，过后回待处理', () => {
    const m = new OrbStateMachine(3000)
    m.setPending(2)
    m.pulseAlert(1000)
    expect(m.currentState(1000)).toBe('alert')
    expect(m.currentState(2000)).toBe('alert')
    expect(m.currentState(4000)).toBe('pending')
  })

  it('非法待处理数按 0 处理（负数 / 小数 / NaN）', () => {
    const m = new OrbStateMachine()
    m.setPending(-1)
    expect(m.pending()).toBe(0)
    expect(m.currentState(0)).toBe('normal')
    m.setPending(Number.NaN)
    expect(m.pending()).toBe(0)
    m.setPending(2.7)
    expect(m.pending()).toBe(2)
    expect(m.currentState(0)).toBe('pending')
  })
})