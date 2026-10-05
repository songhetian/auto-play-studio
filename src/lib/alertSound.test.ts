import { describe, expect, it } from 'vitest'
import {
  ALERT_SOUND_PRESETS,
  alertSoundSchema,
  resolveAlertSound,
  type AlertSoundInput,
} from '@/lib/alertSound'

/**
 * 实例级告警声音的行为规格。
 *
 * 现状问题：声音是**全局一套**，而且只能用系统 TTS 念一段固定文案。
 * 客服场景下这是不可用的 ——
 *  - 不同客户/不同会话需要不同的提示音，靠听声音就知道是哪个实例在报
 *  - TTS 念「出现目标图片 请查看」在嘈杂的客服环境里经常听不清
 *  - 值班的人想换成自己熟悉的提示音（比如挂件铃声），做不到
 *
 * 规格：
 *  - 每个实例单独绑一套声音（monitor 工具）
 *  - 内置若干预设（无需任何文件）
 *  - 也能填自己的音频文件路径（自定义）
 *  - 预设 id 写错 / 扩展名不支持时必须有明确行为，不能静默播错的
 */
describe('实例级告警声音', () => {
  it('内置预设覆盖「静音 / 语音 / 铃声」三类，且有稳定 id 与文案', () => {
    const ids = ALERT_SOUND_PRESETS.map((p) => p.id)
    // 静音必须有：机器人在跑但人不想听，是很常见的需求
    expect(ids).toContain('silent')
    // 语音播报（沿用现在 System.Speech 那套）
    expect(ids).toContain('voice')
    // 至少一个"更醒目"的铃声类预设
    expect(ALERT_SOUND_PRESETS.some((p) => p.kind === 'chime')).toBe(true)
  })

  it('预设 id 唯一 —— 重复会让配置指向不确定的那个', () => {
    const ids = ALERT_SOUND_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('静音预设不播任何声音', async () => {
    const res = resolveAlertSound({ preset: 'silent' })
    expect(res.kind).toBe('silent')
  })

  it('语音预设走 TTS，并把文案带上', () => {
    const res = resolveAlertSound({ preset: 'voice', text: '有新的客户消息' })
    expect(res.kind).toBe('voice')
    if (res.kind === 'voice') expect(res.text).toBe('有新的客户消息')
  })

  it('语音预设没给文案时用默认文案，不能是空串（空串播出来是静默）', () => {
    const res = resolveAlertSound({ preset: 'voice' })
    expect(res.kind).toBe('voice')
    if (res.kind === 'voice') expect(res.text.length).toBeGreaterThan(0)
  })

  it('铃声预设解析成文件播放', () => {
    const res = resolveAlertSound({ preset: 'chime' })
    expect(res.kind).toBe('file')
    if (res.kind === 'file') expect(res.path.length).toBeGreaterThan(0)
  })

  it('自定义音频：只接受 wav / mp3，其余明确判非法', () => {
    expect(resolveAlertSound({ customPath: 'C:/tmp/a.wav' }).kind).toBe('file')
    expect(resolveAlertSound({ customPath: 'C:/tmp/a.mp3' }).kind).toBe('file')
    // .txt / .exe 一律非法，不能"看起来配了但播不出来"
    expect(resolveAlertSound({ customPath: 'C:/tmp/a.txt' }).kind).toBe('invalid')
    expect(resolveAlertSound({ customPath: 'C:/tmp/a.exe' }).kind).toBe('invalid')
  })

  it('自定义路径只有空格 → 当作没填，回落默认语音（不是非法）', () => {
    // 纯空格不是"配错了"，而是"没配"。判 invalid 会让用户莫名看到红色报错
    expect(resolveAlertSound({ customPath: '   ' }).kind).toBe('voice')
  })

  it('没配任何东西 → 回落到语音预设，行为与现在一致', () => {
    // 向后兼容：老实例存档里根本没有 alertSound 字段，不能因此变成哑巴
    expect(resolveAlertSound({}).kind).toBe('voice')
  })

  it('预设 id 不认识 → 回落语音，而不是无声无息', () => {
    expect(resolveAlertSound({ preset: 'nope' as never }).kind).toBe('voice')
  })

  it('同时给了预设与自定义：自定义优先（用户明确选了文件）', () => {
    const res = resolveAlertSound({ preset: 'voice', customPath: 'C:/tmp/a.wav' })
    expect(res.kind).toBe('file')
  })

  it('schema 接受静音/预设/自定义三种写法', () => {
    expect(alertSoundSchema.safeParse({ preset: 'silent' }).success).toBe(true)
    expect(alertSoundSchema.safeParse({ preset: 'voice', text: 'x' }).success).toBe(true)
    expect(alertSoundSchema.safeParse({ customPath: 'C:/a.wav' }).success).toBe(true)
    // 扩展名不对要在保存配置时就拦下，别等真报警时才发现
    expect(alertSoundSchema.safeParse({ customPath: 'C:/a.txt' }).success).toBe(false)
  })

  it('schema 给 alertSound 补默认值：老存档解析后也有字段', () => {
    const r = alertSoundSchema.safeParse(undefined)
    expect(r.success).toBe(true)
    const v = (r as { data?: AlertSoundInput }).data ?? {}
    expect(resolveAlertSound(v).kind).toBe('voice')
  })
})
