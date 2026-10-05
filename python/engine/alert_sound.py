# -*- coding: utf-8 -*-
"""告警声音的**选声决策**（纯函数，可测）。

播放本身是设备层（winmm MCI / 系统 TTS），按项目约定不进自动化测试。
但「这个实例该播什么」是一份纯逻辑：静音不该播、认不出的预设要回落、
自定义文件的扩展名要校验。把决策抽出来单独测，播放只负责照做。
"""
import os

DEFAULT_VOICE_TEXT = "出现目标图片 请查看"

# 铃声预设 → Windows 自带媒体文件。每台 Windows 都有，零体积、不用打包。
PRESET_FILES = {
    "chime": "C:/Windows/Media/Ring01.wav",
    "chime2": "C:/Windows/Media/Ring05.wav",
    "alarm": "C:/Windows/Media/Alarm01.wav",
}

SUPPORTED_EXT = (".wav", ".mp3")

# 与前端 src/lib/alertSound.ts 的 ALERT_SOUND_PRESETS 保持一致（id: kind）
PRESET_KINDS = {
    "voice": "voice",
    "silent": "silent",
    "chime": "chime",
    "chime2": "chime",
    "alarm": "chime",
}


def _has_audio_ext(path):
    return os.path.splitext(path)[1].lower() in SUPPORTED_EXT


def resolve_alert_sound(cfg):
    """把实例配置里的 alertSound 解析成播放指令。

    返回 ``{"mode": "silent"}`` / ``{"mode": "voice", "text": ...}``
    / ``{"mode": "file", "path": ...}`` / ``{"mode": "invalid", "reason": ...}``

    优先级：自定义文件 > 预设 > 默认语音。
    认不出的预设回落到语音而不是静音 —— 配错了要有声音提醒你"这里不对"，
    静默的话用户只会以为监控没生效。
    """
    sound = (cfg or {}).get("alertSound") or {}
    custom = str(sound.get("customPath") or "").strip()
    if custom:
        if not _has_audio_ext(custom):
            return {"mode": "invalid", "reason": "只支持 .wav / .mp3 音频"}
        return {"mode": "file", "path": custom}

    preset = str(sound.get("preset") or "voice").strip() or "voice"
    kind = PRESET_KINDS.get(preset)
    if kind is None:
        # 认不出的预设 id：回落语音
        kind = "voice"
    if kind == "silent":
        return {"mode": "silent"}
    if kind == "voice":
        text = str(sound.get("text") or "").strip() or DEFAULT_VOICE_TEXT
        return {"mode": "voice", "text": text}
    return {"mode": "file", "path": PRESET_FILES.get(preset, PRESET_FILES["chime"])}
