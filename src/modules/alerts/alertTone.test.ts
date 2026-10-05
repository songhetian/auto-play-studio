import { describe, expect, it } from 'vitest'
import { alertStyleOf, notificationTextOf } from './alertTone'

type HitLike = { tool: string; level: string; matchedBy: string }

/**
 * 提醒框按功能分型。
 *
 * 现状问题：图片监控命中与敏感词命中**长得一模一样**（都是红框 + 感叹号），
 * 用户看不出这条是"画面里出现了目标"还是"客服打了不该说的词"——
 * 而这两件事需要的反应完全不同（前者去看屏幕，后者去改话术）。
 */
describe('提醒框按功能分型', () => {
  it('敏感词与图片命中要能一眼分开_靠色相与图标，不只是文案', () => {
    const image = alertStyleOf({ tool: 'monitor', level: 'alert', matchedBy: 'image' })
    const word = alertStyleOf({ tool: 'guard', level: 'alert', matchedBy: 'keyword' })
    // 图标必须不同：一个屏幕框、一个盾牌
    expect(word.icon).not.toBe(image.icon)
    // 标题必须不同
    expect(word.title).not.toBe(image.title)
    // 同为 alert 时强度可以一致（都是最高级），但语气标签不该相同 ——
    // 用 tone 表达"这是哪一类事"，颜色留给级别
    expect(word.tone).not.toBe(image.tone)
  })

  it('每类都给出人话标题_用户一眼知道发生了什么', () => {
    const h: HitLike = { tool: 'guard', level: 'alert', matchedBy: 'keyword' }
    expect(alertStyleOf(h).title).toContain('敏感词')
    expect(alertStyleOf({ tool: 'monitor', level: 'alert', matchedBy: 'image' }).title).toContain('图片')
  })

  it('warn 级比 alert 级语气更轻_不该都用最重的样式', () => {
    const warn = alertStyleOf({ tool: 'guard', level: 'warn', matchedBy: 'keyword' })
    const alert = alertStyleOf({ tool: 'guard', level: 'alert', matchedBy: 'keyword' })
    // 同色相体系里用强度（intensity）分级：边框/徽标的醒目程度不同
    expect(warn.intensity).toBeLessThan(alert.intensity)
    // 提醒停留也要不同：轻的可以一闪而过
    expect(warn.durationMs).toBeLessThan(alert.durationMs)
  })

  it('认不出来的工具回落到中性提醒_不能变红', () => {
    const s = alertStyleOf({ tool: '未来工具', level: 'info', matchedBy: 'unknown' })
    expect(s.accent).toBe('neutral')
    expect(s.title).toBeTruthy()
  })

  it('info 级不响也不久留', () => {
    const s = alertStyleOf({ tool: 'monitor', level: 'info', matchedBy: 'image' })
    expect(s.sound).toBe(false)
    expect(s.durationMs).toBeLessThanOrEqual(4000)
  })

  it('图片识别命中用独立分型（icon/title/色条）', () => {
    const s = alertStyleOf({ tool: 'image', level: 'alert', matchedBy: 'template' })
    expect(s.title).toContain('图片')
    expect(s.icon).toBe('camera')
    expect(s.bar).toBe('bg-emerald-500')
    expect(s.tone).toContain('画面')
  })

  it('视频帧命中用独立分型', () => {
    const s = alertStyleOf({ tool: 'video', level: 'alert', matchedBy: 'frame' })
    expect(s.title).toContain('视频')
    expect(s.icon).toBe('video')
    expect(s.bar).toBe('bg-violet-500')
  })

  it('意图定位结果用独立分型', () => {
    const s = alertStyleOf({ tool: 'intent', level: 'info', matchedBy: 'intent' })
    expect(s.title).toContain('意图')
    expect(s.icon).toBe('target')
    expect(s.bar).toBe('bg-amber-500')
  })

  it('五类功能色条彼此不同_一眼可分', () => {
    const bars = ['monitor', 'guard', 'image', 'video', 'intent'].map(
      (t) => alertStyleOf({ tool: t, level: 'alert', matchedBy: 'x' }).bar,
    )
    expect(new Set(bars).size).toBe(bars.length)
  })

  it('不认识的告警工具回落中性色条而非变红', () => {
    const s = alertStyleOf({ tool: 'unknown-tool', level: 'alert', matchedBy: 'x' })
    expect(s.accent).toBe('neutral')
    expect(s.bar).toBe('bg-muted-foreground/40')
  })
})

/**
 * 三层提醒（系统通知 / 应用内横幅 / 模态弹窗）必须看起来是同一套东西。
 *
 * 割裂的根源不在"三个组件各写各的样式"，而在**它们连文案都不一致**：
 * 系统通知说「监控告警」、横幅说「图片监控命中」、弹窗说「该处理啦」——
 * 同一件事三种说法，用户会以为是三件不同的事。所以先把"这件事叫什么"
 * 收敛到一个纯函数（`notificationTextOf`），三层都从它取。
 */
describe('三层提醒共用一套文案', () => {
  it('系统通知与应用内横幅说同一句话', () => {
    const hit = { tool: 'monitor', level: 'alert', matchedBy: 'image' }
    const style = alertStyleOf(hit)
    // 横幅层的标题
    expect(style.title).toBe('图片监控命中')
    // 系统通知层必须复用同一个标题，而不是另起一套说法
    expect(notificationTextOf(hit).title).toBe(style.title)
  })

  it('系统通知的正文用业务语气标签 + 原文，不重新组织语言', () => {
    const hit = { tool: 'guard', level: 'alert', matchedBy: 'keyword', title: '最佳', detail: '客户面前提到了最好' }
    const n = notificationTextOf(hit)
    expect(n.body).toContain('话里有违禁词')
    expect(n.body).toContain('客户面前提到了最好')
  })

  it('敏感词与图片命中在系统通知里也能分开', () => {
    const a = notificationTextOf({ tool: 'monitor', level: 'alert', matchedBy: 'image' })
    const b = notificationTextOf({ tool: 'guard', level: 'alert', matchedBy: 'keyword' })
    expect(a.title).not.toBe(b.title)
  })

  it('没有 title 时退回人话标题，不给空正文', () => {
    const n = notificationTextOf({ tool: 'monitor', level: 'alert', matchedBy: 'image' })
    expect(n.body).toBeTruthy()
  })

  it('认不出的工具在系统通知里也是中性的', () => {
    // 不知道是什么就不能染红：系统通知的红色最容易引起警觉，乱用等于稀释
    const n = notificationTextOf({ tool: '未来工具', level: 'alert', matchedBy: 'x' })
    expect(n.title).toBeTruthy()
    expect(n.title).not.toContain('敏感词')
  })
})
