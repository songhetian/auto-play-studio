"""命中快照的 HTTP 路由（挂在 /api/hit-snapshots 下）。

只做一件事：把 `snapshots.save_hit_snapshot` 存下的文件按相对路径取回字节，
前端 `<img src>` 直接显示，不用转 base64。

**路径安全是这个路由的全部难点**：相对路径来自数据库（理论上可被篡改），
`../` 能读到 autoplay.db 甚至用户任意文件。所以先用 `resolve()` 归一，
再要求结果仍落在素材库目录内 —— 归一之后还逃得出去的，才是真逃出去了。
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from . import snapshots

router = APIRouter(prefix="/hit-snapshots", tags=["alerts"])


@router.get("/{rel:path}")
def snapshot(rel: str) -> FileResponse:
    """按相对路径返回快照字节。"""
    root = snapshots.assets_root().resolve()
    target = (root / rel).resolve()

    # 归一之后仍不在素材库内 = 路径穿越，直接拒。
    # 用 is_relative_to 而不是 str.startswith：后者会被同名目录骗过
    # （`/data/image_assets_evil` 也 startswith `/data/image_assets`）。
    if not target.is_relative_to(root):
        raise HTTPException(404, "找不到该快照")
    if not target.is_file():
        raise HTTPException(404, "找不到该快照")

    return FileResponse(target, media_type="image/jpeg")
