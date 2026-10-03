# -*- coding: utf-8 -*-
"""Config 数据模型与配置管理。"""
import copy
import json
import os
import threading

# 默认配置
DEFAULT_CONFIG = {
    "general": {
        "run_monitoring": True,
        "poll_interval_ms": 500,
    },
    "alert": {
        "popup_enabled": True,
        # 弹窗时长 = 重复报警间隔（播报期间暂停检测），默认 10 秒
        "popup_timeout_ms": 10000,
        "play_sound": True,
        "sound_file": "",
        "default_text": "出现目标图片 请查看",
        "text_repeat": 3,
        # 画面持续存在时重复报警（与引擎/对话框默认保持一致）
        "repeat_while_visible": True,
    },
    "zones": [],
}


def _deep_merge(base, override):
    """递归合并字典，override 覆盖 base。"""
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


class ConfigManager:
    """负责任务配置的加载、保存、热更新与变更通知。"""

    def __init__(self, path="config.json"):
        self.path = os.path.abspath(path)
        self._data = copy.deepcopy(DEFAULT_CONFIG)
        self._lock = threading.RLock()
        self._listeners = []
        self.load()

    # ---------- 读写 ----------
    def load(self):
        """从磁盘加载配置；缺失字段用默认值补齐。"""
        loaded = {}
        if os.path.exists(self.path):
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
            except (json.JSONDecodeError, OSError):
                loaded = {}
        with self._lock:
            self._data = _deep_merge(DEFAULT_CONFIG, loaded)

    def save(self):
        """将当前配置写回磁盘。"""
        with self._lock:
            payload = copy.deepcopy(self._data)
        try:
            with open(self.path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
        except OSError:
            pass

    def get(self, key, default=None):
        """按点分路径读取，例如 get('detection.drag_drop_enabled')。"""
        with self._lock:
            node = self._data
            for part in key.split("."):
                if not isinstance(node, dict) or part not in node:
                    return default
                node = node[part]
            return node

    def set(self, key, value):
        """按点分路径写入并触发通知。"""
        with self._lock:
            parts = key.split(".")
            node = self._data
            for part in parts[:-1]:
                node = node.setdefault(part, {})
            node[parts[-1]] = value
            changed = True
        if changed:
            self._notify(key, value)

    def update_section(self, section, values):
        """整体替换某节配置（如 render 期批量更新）。"""
        with self._lock:
            self._data[section] = copy.deepcopy(values)
        self._notify(section, values)

    # ---------- 快照 ----------
    def snapshot(self):
        with self._lock:
            return copy.deepcopy(self._data)

    # ---------- 监控区(zones) : list 专用读写 ----------
    def get_zones(self):
        with self._lock:
            return copy.deepcopy(self._data.get("zones", []))

    def set_zones(self, zones):
        with self._lock:
            self._data["zones"] = copy.deepcopy(zones)
        self._notify("zones", copy.deepcopy(zones))

    def add_zone(self, zone):
        with self._lock:
            self._data.setdefault("zones", []).append(copy.deepcopy(zone))
            zones = copy.deepcopy(self._data["zones"])
        self._notify("zones", zones)

    def update_zone(self, zone_id, **fields):
        with self._lock:
            zones = self._data.setdefault("zones", [])
            for z in zones:
                if z.get("id") == zone_id:
                    z.update(fields)
                    break
            zones = copy.deepcopy(zones)
        self._notify("zones", zones)

    def remove_zone(self, zone_id):
        with self._lock:
            zones = self._data.setdefault("zones", [])
            self._data["zones"] = [z for z in zones if z.get("id") != zone_id]
            zones = copy.deepcopy(self._data["zones"])
        self._notify("zones", zones)

    # ---------- 变更通知 ----------
    def add_listener(self, callback):
        """注册变更回调 callback(key, value)。返回取消订阅函数。"""
        self._listeners.append(callback)
        return lambda: self._listeners.remove(callback)

    def _notify(self, key, value):
        for cb in list(self._listeners):
            try:
                cb(key, value)
            except Exception:
                pass