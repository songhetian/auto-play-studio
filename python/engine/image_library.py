"""图像素材库：图像指令要匹配的那些图，集中存这里。

分两层各管一件事：
  * 磁盘 —— 素材按 id 命名保存在 AUTOPLAY_ASSETS_DIR（默认在库文件旁边的 image_assets/），
    用 id 而不是原名，避免中文名、重名、路径穿越这些问题；
  * 数据库 —— image_assets 表存元数据（展示名、尺寸、阈值、标签）。

引用关系在 image_refs.py 里算，这里只管素材本身。
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

from . import db, image_meta

DEFAULT_TAG = "按钮类"
DEFAULT_THRESHOLD = 0.85

_EXT = {"png": ".png", "jpeg": ".jpg", "gif": ".gif", "bmp": ".bmp", "webp": ".webp"}


def assets_dir() -> Path:
    """素材目录。跟库文件放一起（打包后在 userData 下），可用环境变量覆盖。"""
    configured = os.environ.get("AUTOPLAY_ASSETS_DIR")
    base = Path(configured) if configured else Path(db.DB_PATH).parent / "image_assets"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "path": row["path"],
        "width": row["width"],
        "height": row["height"],
        "threshold": row["threshold"],
        "tag": row["tag"],
        "createdAt": row["created_at"],
    }


def list_images() -> list[dict[str, Any]]:
    # created_at 只到秒，同一秒导入的多张会并列 —— 用 rowid（真实插入顺序）兜底，
    # 否则 id 是随机 uuid，排序结果会飘。
    return [
        _row_to_dict(r)
        for r in db.query("SELECT * FROM image_assets ORDER BY created_at DESC, rowid DESC")
    ]


def get_image(asset_id: str) -> dict[str, Any] | None:
    rows = db.query("SELECT * FROM image_assets WHERE id=?", (asset_id,))
    return _row_to_dict(rows[0]) if rows else None


def import_image(
    name: str,
    data: bytes | None = None,
    *,
    source_path: str | Path | None = None,
    tag: str = DEFAULT_TAG,
    threshold: float = DEFAULT_THRESHOLD,
) -> dict[str, Any]:
    """导入一张素材：校验真是图片 → 按 id 落盘 → 元数据入库。

    data 与 source_path 二选一：前者用于上传/截图，后者用于「从磁盘某处导入」。
    """
    if data is None:
        if source_path is None:
            raise ValueError("没有提供图片内容")
        data = Path(source_path).read_bytes()
    if not data:
        raise ValueError("图片内容为空")

    kind = image_meta.sniff(data[:64])
    if not kind:
        raise ValueError("这不是一张能识别的图片（支持 PNG / JPG / GIF / BMP / WEBP）")

    size = image_meta.size(data[:65536])
    width, height = size if size else (0, 0)

    asset_id = "img_" + uuid.uuid4().hex[:10]
    path = assets_dir() / f"{asset_id}{_EXT.get(kind, '.png')}"
    path.write_bytes(data)

    display_name = (name or "").strip() or f"素材 {asset_id[-4:]}"
    with db.write() as c:
        c.execute(
            "INSERT INTO image_assets(id, name, path, width, height, threshold, tag) VALUES (?,?,?,?,?,?,?)",
            (asset_id, display_name, str(path), width, height, float(threshold), tag or DEFAULT_TAG),
        )
    return get_image(asset_id)  # type: ignore[return-value]


def update_image(
    asset_id: str,
    *,
    name: str | None = None,
    tag: str | None = None,
    threshold: float | None = None,
) -> dict[str, Any] | None:
    """改展示名 / 标签 / 阈值。文件与 id 不变，所以已引用它的指令自动跟着生效。"""
    current = get_image(asset_id)
    if current is None:
        return None
    fields = {
        "name": name.strip() if isinstance(name, str) and name.strip() else current["name"],
        "tag": tag if tag else current["tag"],
        "threshold": float(threshold) if threshold is not None else current["threshold"],
    }
    with db.write() as c:
        c.execute(
            "UPDATE image_assets SET name=?, tag=?, threshold=? WHERE id=?",
            (fields["name"], fields["tag"], fields["threshold"], asset_id),
        )
    return get_image(asset_id)


def delete_image(asset_id: str, *, force: bool = False) -> bool:
    """删除素材。被指令引用时默认拒绝（ImageInUse）；force=True 则连带清掉引用。

    「清引用」必须发生在这里 —— 删素材只有这一条路，否则强删之后指令里
    会留下一个指向空气的 assetId，下次执行才报「素材不存在」。
    """
    from . import image_refs

    current = get_image(asset_id)
    if current is None:
        return False

    if force:
        image_refs.detach_references(asset_id)
    else:
        image_refs.ensure_unused(asset_id)

    with db.write() as c:
        c.execute("DELETE FROM image_assets WHERE id=?", (asset_id,))
    _remove_file(Path(current["path"]))
    return True


def _remove_file(path: Path) -> None:
    """删文件失败不该让删除操作半途而废（记录已删，文件留着不影响使用）。"""
    try:
        if path.is_file():
            path.unlink()
    except OSError:
        pass


def copy_into_library(source: str | Path, name: str = "", **kw: Any) -> dict[str, Any]:
    """把外部文件复制进库（保留原文件）。"""
    src = Path(source)
    if not src.is_file():
        raise ValueError(f"文件不存在：{src}")
    return import_image(name or src.stem, data=src.read_bytes(), **kw)


__all__ = [
    "assets_dir",
    "import_image",
    "list_images",
    "get_image",
    "update_image",
    "delete_image",
    "copy_into_library",
]
