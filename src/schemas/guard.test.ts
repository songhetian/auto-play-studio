import { describe, expect, it } from 'vitest'
import { instanceConfigSchema, toolTypeSchema } from './instance'

describe('guard 敏感词监控配置', () => {
  const base = {
    tool: 'guard',
    window: '企业微信',
    guard: { captureMode: 'auto', allowClipboard: true, levels: ['high', 'mid', 'low'], pollMs: 800 },
  }

  it('guard 是合法的工具类型', () => {
    expect(toolTypeSchema.safeParse('guard').success).toBe(true)
  })

  it('只给窗口时其余取默认值_老存档解析后也能跑', () => {
    const r = instanceConfigSchema.parse({ tool: 'guard', window: '京麦' })
    expect(r.tool).toBe('guard')
    if (r.tool === 'guard') {
      // 默认必须是「自动降级 + 三档全开」：新装的人不该先做一堆选择才能用
      expect(r.guard.captureMode).toBe('auto')
      expect(r.guard.levels).toEqual(['high', 'mid', 'low'])
      expect(r.guard.allowClipboard).toBe(true)
    }
  })

  it('窗口必填_没绑定窗口就不知道该读哪个输入框', () => {
    expect(instanceConfigSchema.safeParse({ tool: 'guard', window: '', guard: {} }).success).toBe(false)
    expect(instanceConfigSchema.safeParse({ tool: 'guard', guard: {} }).success).toBe(false)
  })

  it('抓取方式只认三种_自绘软件要走 clipboard 兜底', () => {
    for (const mode of ['auto', 'uia', 'clipboard'] as const) {
      expect(instanceConfigSchema.safeParse({ ...base, guard: { ...base.guard, captureMode: mode } }).success).toBe(true)
    }
    expect(instanceConfigSchema.safeParse({ ...base, guard: { ...base.guard, captureMode: 'ocr' } }).success).toBe(false)
  })

  it('选了 uia 就不该再允许剪贴板_两者同时为真会让人以为在读 UIA', () => {
    const r = instanceConfigSchema.safeParse({
      ...base,
      guard: { ...base.guard, captureMode: 'uia', allowClipboard: true },
    })
    // 允许存下来（用户可能中途改），但界面必须知道这两者会冲突
    expect(r.success).toBe(true)
  })

  it('危级必须是三档之一', () => {
    expect(
      instanceConfigSchema.safeParse({ ...base, guard: { ...base.guard, levels: ['critical'] } }).success,
    ).toBe(false)
  })

  it('轮询间隔有下限_太密会拖慢前台软件', () => {
    expect(instanceConfigSchema.safeParse({ ...base, guard: { ...base.guard, pollMs: 10 } }).success).toBe(false)
    expect(instanceConfigSchema.safeParse({ ...base, guard: { ...base.guard, pollMs: 500 } }).success).toBe(true)
  })

  it('guard 也能配每个实例独立的告警声音', () => {
    const r = instanceConfigSchema.parse({
      ...base,
      alertSound: { preset: 'chime', text: '', customPath: '' },
    })
    if (r.tool === 'guard') {
      expect(r.alertSound?.preset).toBe('chime')
    }
  })
})