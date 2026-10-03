"""知识库的 HTTP 路由（挂在 /api/kb 下）。

路由只做参数校验与错误码，业务全在 `service` 里。
响应字段一律 camelCase —— 与前端读的那套一致（`engine/kb/service.py` 里拼好，
这里不再翻译一遍，免得两边各写一份字段名）。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import service

router = APIRouter(prefix="/kb", tags=["kb"])


class FolderIn(BaseModel):
    path: str


class OpenIn(BaseModel):
    path: str


@router.get("/status")
def get_status() -> dict:
    return service.status()


@router.get("/search")
def search(q: str = "", limit: int = service.MAX_RESULTS) -> dict:
    return service.search(q, limit)


@router.get("/folders")
def list_folders() -> dict:
    return {"folders": service.status()["folders"]}


@router.post("/folders")
def add_folder(body: FolderIn) -> dict:
    path = (body.path or "").strip()
    if not path:
        raise HTTPException(400, "文件夹路径是空的")
    return service.add_folder(path)


@router.delete("/folders")
def remove_folder(path: str) -> dict:
    if not (path or "").strip():
        raise HTTPException(400, "文件夹路径是空的")
    return {"removed": service.remove_folder(path)}


@router.post("/reindex")
def reindex() -> dict:
    return service.reindex_all()


@router.get("/history")
def history(limit: int = 20) -> dict:
    return service.history(limit)


@router.delete("/history")
def clear_history() -> dict:
    service.clear_history()
    return {"ok": True}


@router.post("/open")
def open_file(body: OpenIn) -> dict:
    """用系统默认程序打开一个已索引的文件。

    只允许打开库里有的路径：这是个本机进程，「能打开任意路径」就等于
    给前端塞进来的任何字符串配了一个可执行动作。
    """
    try:
        service.open_file(body.path or "")
    except LookupError:
        raise HTTPException(404, "这个文件不在知识库里")
    except OSError as e:  # 文件被删了 / 没有关联程序
        raise HTTPException(400, f"打不开：{e}") from e
    return {"ok": True}
