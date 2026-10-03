# -*- coding: utf-8 -*-
"""声音告警：统一播放 mp3/wav，未设置声音时用系统语音合成中文告警，支持播放状态查询。

- mp3 / wav 统一走 winmm MCI **阻塞式**播放（play ... wait），在后台线程执行：
  线程活着 = 还在播 → is_playing() 永远真实；单通道 + 新播先停旧播 → 绝不叠音。
- 未设置自定义声音 → 用 Windows 自带 System.Speech（PowerShell）把告警文案合成 wav 再播放，
  无需第三方 Python 依赖；合成失败时回退系统默认提示音。
- 旧实现 mp3 是"开新 alias 立即返回"的重叠式播放，重报间隔(5s)短于语音时长时
  会两条声音叠在一起；且固定 12 秒后强关设备，长语音被截断。本版全部修复。
"""
import ctypes
import os
import subprocess
import tempfile
import threading
import time

import winsound

winmm = ctypes.windll.winmm

_SND_FILENAME = 0x00020000
_SND_ASYNC = 0x0001
_SND_ALIAS = 0x00010000

_lock = threading.Lock()        # 播放设备串行锁（同一时刻只允许一段在播）
_state_lock = threading.Lock()
_playing = False
_current_stop = None            # 当前播放的停止事件（新播放用它掐断旧播放）
_MCI_ALIAS = "notic_alarm"      # 全局唯一 alias：天然单通道


# ---------- 对外接口 ----------
def play(sound_file="", text="出现目标图片 请查看", repeat=3):
    """播放告警声音（非阻塞，后台线程）。先停掉正在播的上一条，绝不叠音。
    repeat 仅用于默认语音连读遍数。
    """
    _stop_current()
    ev = threading.Event()
    global _current_stop
    with _state_lock:
        _current_stop = ev
    if sound_file and os.path.isfile(sound_file):
        _spawn(_run_file, str(sound_file), ev)
    else:
        _spawn(_run_synthesized, str(text), int(repeat), ev)


def is_playing():
    with _state_lock:
        return _playing


def stop():
    """立即停止当前播放（播报被挂起/关闭程序时调用）。"""
    _stop_current()


# ---------- 文案拼接（纯函数，便于单测） ----------
def build_phrase(text, repeat):
    """例：("出现目标图片 请查看", 3) -> "出现目标图片 请查看，出现目标图片 请查看，出现目标图片 请查看"
    纯字符处理（去掉标点，读起来更自然）。"""
    parts = [text.strip().rstrip("，。.")] * max(1, int(repeat or 1))
    return "，".join(parts)


# ---------- 内部：单通道播放 ----------
def _stop_current():
    """掐断当前播放：置停止事件 + 停掉 MCI/winsound 设备。"""
    global _current_stop
    with _state_lock:
        ev = _current_stop
        _current_stop = None
    if ev is not None:
        ev.set()
    # MCI：stop 让阻塞中的 "play wait" 立即返回（设备可能不存在，忽略错误）
    winmm.mciSendStringW("stop %s" % _MCI_ALIAS, None, 0, None)
    winmm.mciSendStringW("close %s" % _MCI_ALIAS, None, 0, None)
    # winsound 残留（回退路径/系统提示音）
    try:
        winsound.PlaySound(None, 0)
    except Exception:
        pass


def _spawn(fn, *args):
    t = threading.Thread(target=_run_safely, args=(fn, args), daemon=True)
    t.start()


def _run_safely(fn, args):
    global _playing, _current_stop
    with _state_lock:
        _playing = True
    try:
        fn(*args)
    except Exception:
        pass
    finally:
        with _state_lock:
            _playing = False
            if args and _current_stop is args[-1]:
                _current_stop = None


def _run_file(path, stop_ev):
    with _lock:
        if stop_ev.is_set():
            return
        _play_file(path, stop_ev)


def _play_file(path, stop_ev):
    """阻塞式播放单个文件（mp3/wav 统一 MCI wait），直到播完或被 stop 掐断。
    在后台线程 + _lock 内执行；设备名全局唯一 → 物理上不可能叠音。"""
    cmd = winmm.mciSendStringW
    ext = os.path.splitext(path)[1].lower()
    atype = "mpegvideo" if ext == ".mp3" else ("waveaudio" if ext == ".wav" else None)
    # 清掉可能残留的同名设备后重新打开
    cmd("close %s" % _MCI_ALIAS, None, 0, None)
    if atype:
        err = cmd('open "%s" type %s alias %s' % (path, atype, _MCI_ALIAS), None, 0, None)
    else:
        err = cmd('open "%s" alias %s' % (path, _MCI_ALIAS), None, 0, None)
    if err != 0:
        _fallback_play(path)
        return
    try:
        cmd("play %s wait" % _MCI_ALIAS, None, 0, None)
    finally:
        cmd("close %s" % _MCI_ALIAS, None, 0, None)


def _play_system_default():
    try:
        winsound.PlaySound("SystemAsterisk", _SND_ALIAS | _SND_ASYNC)
    except Exception:
        pass


def _run_synthesized(text, repeat, stop_ev):
    """后台线程：合成默认告警语音并播放；合成失败回退系统默认提示音。"""
    with _lock:
        if stop_ev.is_set():
            return
        wav = _synthesize(text, repeat)
        if wav:
            _play_file(wav, stop_ev)
        else:
            _play_system_default()


def _fallback_play(path):
    """MCI 打不开时的兜底：wav 用 winsound 阻塞播（仍在后台线程，不卡主线程）。"""
    if os.path.splitext(path)[1].lower() == ".wav":
        try:
            winsound.PlaySound(path, _SND_FILENAME)
        except Exception:
            pass
    # 其它格式（mp3 等）无可用回退，静默


# ---------- TTS 合成 ----------
def _synthesize(text, repeat):
    """用 System.Speech 将文案合成到 wav，返回路径；失败返回 None。
    同一文案+遍数只合成一次，结果缓存复用——避免每次播报都重启 PowerShell 子进程。
    """
    phrase = build_phrase(text, repeat)
    # 缓存名由文案/遍数决定：同配置复用，改动后自动重建
    cache = os.path.join(tempfile.gettempdir(), "notic_voice_%d.wav" % _stable_hash(phrase))
    if os.path.isfile(cache) and os.path.getsize(cache) > 0:
        return cache
    tmp = cache + ".tmp%d" % os.getpid()
    ps = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "$s.SetOutputToWaveFile('%s'); " % _esc(tmp) +
        "$s.Speak('%s'); " % _esc(phrase) +
        "$s.Dispose();"
    )
    try:
        subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive",
             "-ExecutionPolicy", "Bypass", "-Command", ps],
            capture_output=True, timeout=30, check=True)
    except Exception:
        return None
    if os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
        try:
            os.replace(tmp, cache)
            return cache
        except Exception:
            return tmp
    return None


def _stable_hash(s):
    """稳定且轻量的字符串散列（避免每次重建缓存名）。"""
    h = 0x811C9DC5
    for ch in s.encode("utf-8"):
        h ^= ch
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def _esc(s):
    # PowerShell 单引号字符串转义
    return s.replace("'", "''")