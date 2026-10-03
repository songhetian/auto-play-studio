"""配置存取（v2）：保存“A 表参与字段 + 各对比表列映射”，按文件名复用。

用途：配置好一组文件后保存为 .json；下次换同结构文件一键载入，实现多次对比复用。
映射按【文件名】匹配，因此载入时只要当前已上传同名文件即可复用。
"""
from __future__ import annotations

import json
import os


def dump_config(primary, primary_fields, others, tolerance) -> dict:
    return {
        "version": 2,
        "primary": primary["name"] if primary else None,
        "tolerance": tolerance,
        "primary_fields": [
            {"name": f["name"], "role": f["role"], "type": f.get("type", "text")}
            for f in primary_fields
        ],
        "others": [
            {"name": o["table"]["name"], "maps": dict(o.get("maps", {}))}
            for o in others
        ],
    }


def save_config_file(path, primary, primary_fields, others, tolerance):
    cfg = dump_config(primary, primary_fields, others, tolerance)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)


def load_config_file(path) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    if not isinstance(cfg, dict) or "primary_fields" not in cfg:
        raise ValueError("配置文件格式不正确（需要 v2 结构）")
    return cfg


def auto_config_path() -> str:
    base = os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "ExcelCompare")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "last_config.json")


def apply_config(cfg: dict, primary, primary_fields, others, tolerance):
    """把配置应用到当前已加载的文件，返回 (new_primary_fields, new_others, new_tolerance)。

    匹配规则：主表按文件名；对比表按文件名，再按 A 字段名 -> 列名 回填映射。
    主表名对不上时整套方案都不生效 —— 容差是业务口径，跟着主表走，不能张冠李戴。
    """
    matched = bool(primary and cfg.get("primary") == primary["name"])
    new_fields = []
    if matched:
        # 以配置为主，按 A 列名匹配（保留 A 当前实际列名作为字段名）
        cfg_fields = cfg.get("primary_fields", [])
        for col in primary["columns"]:
            cf = next((f for f in cfg_fields if f["name"] == col), None)
            if cf:
                new_fields.append({
                    "name": col,
                    "role": cf.get("role", "compare"),
                    "type": cf.get("type", "text"),
                })
    else:
        new_fields = list(primary_fields)

    new_others = []
    for o in others:
        nm = o["table"]["name"]
        co = next((x for x in cfg.get("others", []) if x.get("name") == nm), None)
        maps = {f["name"]: None for f in new_fields}
        if co:
            for aname, col in co.get("maps", {}).items():
                if aname in maps and col in o["table"]["columns"]:
                    maps[aname] = col
        new_others.append({"table": o["table"], "maps": maps})

    new_tol = cfg.get("tolerance", tolerance) if matched else tolerance
    if not isinstance(new_tol, (int, float)):
        new_tol = tolerance
    return new_fields, new_others, new_tol
