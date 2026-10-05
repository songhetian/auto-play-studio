import { z } from 'zod'

/**
 * 实例级告警声音。
 *
 * 为什么要从「全局一套」改成「每实例可配」：
 * 客服环境里同时盯着好几个会话，报警时需要靠**声音本身**分辨是哪个实例在报，
 * 而不是只看到一个弹窗再回头去查。原来的固定 TTS 文案在嘈杂环境里也经常听不清。
 *
 * 三种形态：
 *  - `silent` 静音：机器人在跑、人不想听（很常见）
 *  - `voice`  语音：系统 TTS 念一段文案（沿用原有行为，向后兼容）
 *  - `file`   文件：Windows 自带铃声，或用户自己的 wav/mp3
 */

export type AlertSoundKind = 'silent' | 'voice' | 'file' | 'invalid'

export interface AlertSoundPreset {
  id: string
  label: string
  kind: 'silent' | 'voice' | 'chime'
  /** 一句话说明这个声音听起来是什么样，帮用户凭描述选 */
  hint: string
}

/**
 * 内置预设。
 *
 * 铃声用 `C:\Windows\Media\` 下的系统自带 wav：**每台 Windows 都有、零体积、不用打包**，
 * 不用为了一个提示音往安装包里塞音频资源。
 */
export const ALERT_SOUND_PRESETS: AlertSoundPreset[] = [
  { id: 'voice', label: '语音播报', kind: 'voice', hint: '系统合成中文语音念出提示，默认就是这个' },
  { id: 'silent', label: '静音', kind: 'silent', hint: '只弹窗、不出声' },
  { id: 'chime', label: '清脆提示音', kind: 'chime', hint: '短促的一声"叮"，适合嘈杂环境' },
  { id: 'chime2', label: '双音提示', kind: 'chime', hint: '两声递进的提示音，比单声更容易被注意到' },
  { id: 'alarm', label: '闹钟铃声', kind: 'chime', hint: '最醒目，隔几个工位都能听见' },
]

/** 铃声预设 → Windows 系统媒体文件。找不到时回落到 Windows 默认提示音。 */
const PRESET_FILES: Record<string, string> = {
  chime: 'C:/Windows/Media/Ring01.wav',
  chime2: 'C:/Windows/Media/Ring05.wav',
  alarm: 'C:/Windows/Media/Alarm01.wav',
}

const DEFAULT_VOICE_TEXT = '出现目标图片 请查看'

/** 支持的音频扩展名：只有 MCI 能可靠播的两种 */
const AUDIO_EXT = ['.wav', '.mp3']

const hasAudioExt = (p: string) => {
  const lower = p.toLowerCase()
  return AUDIO_EXT.some((ext) => lower.endsWith(ext))
}

/** 供 UI 做即时校验：给用户红框提示，而不是等保存失败才说 */
export const isAudioPath = (p: string): boolean => {
  const v = (p ?? '').trim()
  return v === '' || hasAudioExt(v)
}

export type ResolveResult =
  | { kind: 'silent' }
  | { kind: 'voice'; text: string }
  | { kind: 'file'; path: string; preset?: string }
  | { kind: 'invalid'; reason: string }

/** 解析用的入参：允许部分字段（老存档 / 表单草稿都可能缺项） */
export type AlertSoundInput = {
  preset?: string
  text?: string
  customPath?: string
}

/**
 * 解析成「该怎么播」。
 *
 * 优先级：自定义文件 > 预设 > 默认语音。
 * 认不出的预设 id 回落到语音而不是静默 —— 配错了要有声音提醒你"这里不对"，
 * 静默的话用户只会以为监控没生效。
 */
export function resolveAlertSound(cfg: AlertSoundInput | undefined): ResolveResult {
  const custom = (cfg?.customPath ?? '').trim()
  if (custom) {
    if (!hasAudioExt(custom)) {
      return { kind: 'invalid', reason: '只支持 .wav / .mp3 音频' }
    }
    return { kind: 'file', path: custom }
  }

  const preset = (cfg?.preset ?? 'voice').trim() || 'voice'
  const known = ALERT_SOUND_PRESETS.find((p) => p.id === preset)

  if (!known) return { kind: 'voice', text: (cfg?.text ?? '').trim() || DEFAULT_VOICE_TEXT }
  if (known.kind === 'silent') return { kind: 'silent' }
  if (known.kind === 'voice') return { kind: 'voice', text: (cfg?.text ?? '').trim() || DEFAULT_VOICE_TEXT }

  return { kind: 'file', path: PRESET_FILES[known.id] ?? 'C:/Windows/Media/Ring01.wav', preset: known.id }
}

/** 预设的展示路径（给配置页「试听/当前使用」用） */
export const presetFileOf = (presetId: string): string | null => PRESET_FILES[presetId] ?? null

export const alertSoundSchema = z
  .object({
    preset: z.string().min(1).default('voice'),
    /** 语音播报文案；为空时用默认 */
    text: z.string().default(''),
    /** 自定义音频绝对路径（wav/mp3） */
    customPath: z.string().default(''),
  })
  .default({ preset: 'voice', text: '', customPath: '' })
  .refine((v) => !v.customPath || hasAudioExt(v.customPath.trim()), {
    message: '只支持 .wav / .mp3 音频文件',
    path: ['customPath'],
  })

export type AlertSound = z.infer<typeof alertSoundSchema>
