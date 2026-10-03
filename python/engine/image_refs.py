"""素材引用：哪些实例的哪几条指令在用这张图。

删素材之前必须先问这一句 —— 一张被三个实例引用的「确定」按钮图被删掉，
那边下次执行就会莫名其妙失败，而且很难查。所以默认拦住，把「谁在用」摆出来。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

from . import db, image_library


class ImageInUse(ValueError):
    """素材正被指令引用，删除被拒绝。"""

    def __init__(self, asset_id: str, refs: list[dict[str, Any]]) -> None:
        where = "、".join(f"{r['instanceName']}的第 {r['cmdIndex'] + 1} 条指令" for r in refs[:3])
        more = f" 等 {len(refs)} 处" if len(refs) > 3 else ""
        super().__init__(f"这张图正被 {where}{more} 引用，删除会让那些指令失效。确认要删请选择「强制删除」。")
        self.asset_id = asset_id
        self.refs = refs


def _iter_commands() -> Iterator[tuple[dict[str, Any], int, dict[str, Any]]]:
    """遍历所有实例的所有 rpa 指令，产出 (实例行, 指令下标, 指令)。"""
    for row in db.query("SELECT id, name, config_json FROM instances ORDER BY created_at"):
        try:
            cfg = json.loads(row["config_json"] or "{}")
        except json.JSONDecodeError:
            continue  # 坏配置跳过：体检不该因为一条脏数据整体报错
        cmds = ((cfg.get("rpa") or {}).get("cmds")) or []
        for i, cmd in enumerate(cmds):
            yield row, i, cmd


def reference_map() -> dict[str, list[dict[str, Any]]]:
    """一次扫描，把所有被引用的素材按 assetId 归好类。

    列表页要显示每张图的引用数、体检要逐条报问题、删除前要问「谁在用」——
    三处要的都是同一份扫描结果，只扫一遍。
    """
    out: dict[str, list[dict[str, Any]]] = {}
    for row, i, cmd in _iter_commands():
        asset_id = (cmd.get("image") or {}).get("assetId")
        if not asset_id:
            continue
        out.setdefault(asset_id, []).append(
            {
                "instanceId": row["id"],
                "instanceName": row["name"],
                "cmdIndex": i,
                "cmdName": cmd.get("t", "未命名指令"),
            }
        )
    return out


def find_references(asset_id: str) -> list[dict[str, Any]]:
    """引用该素材的位置列表。"""
    return reference_map().get(asset_id, [])


def ensure_unused(asset_id: str) -> None:
    """被引用就抛 ImageInUse，附带引用位置。"""
    refs = find_references(asset_id)
    if refs:
        raise ImageInUse(asset_id, refs)


def detach_references(asset_id: str) -> int:
    """把引用该素材的指令里的 assetId 清空，返回清理处数。

    只清 assetId，指令本身（阈值、超时、偏移）原样保留 —— 用户重新选张图就能用，
    不用从零再配一条指令。
    """
    refs = find_references(asset_id)
    by_instance: dict[str, list[int]] = {}
    for ref in refs:
        by_instance.setdefault(ref["instanceId"], []).append(ref["cmdIndex"])

    for instance_id, indexes in by_instance.items():
        rows = db.query("SELECT config_json FROM instances WHERE id=?", (instance_id,))
        if not rows:
            continue
        cfg = json.loads(rows[0]["config_json"] or "{}")
        cmds = ((cfg.get("rpa") or {}).get("cmds")) or []
        for i in indexes:
            if 0 <= i < len(cmds):
                cmds[i].setdefault("image", {})["assetId"] = ""
        db.save_config(instance_id, cfg)

    return len(refs)


def audit() -> list[dict[str, Any]]:
    """体检：找出「引用了不存在的素材」和「素材文件丢了」两类问题。

    执行时才报「图像库里没有这个素材」就太晚了 —— 配好之后就该能检查出来。
    """
    problems: list[dict[str, Any]] = []
    known = {img["id"]: img for img in image_library.list_images()}

    for asset_id, refs in reference_map().items():
        if asset_id in known:
            if Path(known[asset_id]["path"]).is_file():
                continue
            kind, detail = "missing_file", "素材文件在磁盘上找不到了"
        else:
            kind, detail = "missing_asset", "引用的素材已不在图像库中"

        problems.extend({**ref, "assetId": asset_id, "kind": kind, "detail": detail} for ref in refs)

    return problems


def delete_with_policy(asset_id: str, *, force: bool = False) -> dict[str, Any]:
    """按策略删除，返回受影响情况（给接口层用）。

    真正的删除与清引用都在 image_library.delete_image 里做，
    这里只负责先算好「拦不拦」并回一个计数。
    """
    refs = find_references(asset_id)
    if refs and not force:
        raise ImageInUse(asset_id, refs)

    deleted = image_library.delete_image(asset_id, force=force)
    return {"deleted": deleted, "clearedRefs": len(refs) if deleted else 0}
